// bb-plugin-specialists — specialist agents you can @mention.
//
// A specialist is a named agent preset: description, prompt, and model. One
// store in bb.storage.kv serves every surface: the Specialists page (app.tsx,
// over RPC), the `@` mention provider, the `specialist_handoff` agent tool,
// and the `bb specialists` CLI.
//
// Mentioning a specialist attaches agent-only context telling the mentioning
// thread to hand the work off. The handoff spawns a child thread on the
// specialist's model, in the mentioning thread's workspace, so the specialist
// sees the same files and uncommitted changes.
import {
  PluginCliError,
  cliCommand,
  defineCli,
  defineRpcContract,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { z } from "zod";

const REASONING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
const PERMISSION_MODES = ["full", "auto", "accept-edits"] as const;

/** Lowercase so `@reviewer` reads naturally and doubles as the stable id. */
const nameSchema = z
  .string()
  .trim()
  .regex(
    /^[a-z0-9][a-z0-9-]{0,31}$/u,
    "Name must be 1-32 lowercase letters, digits, or dashes",
  );

const specialistSchema = z.object({
  name: nameSchema,
  description: z.string().trim().max(300),
  prompt: z.string().trim().min(1, "Prompt is required").max(50_000),
  // null means "whatever the project would use for a new thread".
  providerId: z.string().min(1).nullable(),
  model: z.string().min(1).nullable(),
  reasoningLevel: z.enum(REASONING_LEVELS).nullable(),
  // What the specialist's thread may do without asking. Rows saved before
  // this setting existed parse as full access.
  permissionMode: z.enum(PERMISSION_MODES).default("full"),
});
export type Specialist = z.infer<typeof specialistSchema>;

/** Per-handoff model change; omitted fields keep the specialist's own. */
const modelOverrideSchema = z.object({
  providerId: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  reasoningLevel: z.enum(REASONING_LEVELS).optional(),
});
type ModelOverride = z.infer<typeof modelOverrideSchema>;

/** The execution settings a handoff runs with, after any override. */
function resolveExecution(
  specialist: Specialist,
  override: ModelOverride,
): Pick<Specialist, "providerId" | "model" | "reasoningLevel"> {
  const providerId = override.providerId ?? specialist.providerId;
  // A saved model belongs to the saved provider. Switching provider without
  // naming a model falls back to that provider's default.
  const providerChanged =
    override.providerId !== undefined &&
    override.providerId !== specialist.providerId;
  const model = override.model ?? (providerChanged ? null : specialist.model);
  return {
    providerId,
    model,
    reasoningLevel: override.reasoningLevel ?? specialist.reasoningLevel,
  };
}

const modelSelectionSchema = z.object({
  providerId: z.string(),
  model: z.string(),
  reasoningLevel: z.enum(REASONING_LEVELS),
});

const handoffInputSchema = z.object({
  specialist: z.string(),
  task: z.string().trim().min(1).max(100_000),
  projectId: z.string(),
  // The workspace to share; null runs in the project's default.
  environmentId: z.string().nullable(),
  // Who is asking, as the specialist should read it, e.g. "The sage X".
  requestedBy: z.string().trim().min(1).max(200),
  // Optional plugin-owned parent and recovery identity (e.g. an Envoy PR).
  parentThreadId: z.string().optional(),
  handoffKey: z.string().min(1).max(200).optional(),
  // Optional: run this one handoff on a different model.
  override: modelOverrideSchema.optional(),
});
const keyedHandoffResultSchema = z.object({
  status: z.enum(["started", "failed", "uncertain"]),
  threadId: z.string().nullable(),
  error: z.string().nullable(),
});
type KeyedHandoffResult = z.infer<typeof keyedHandoffResultSchema>;

export const rpcContract = defineRpcContract({
  specialists_list: {
    input: z.null(),
    output: z.object({ specialists: z.array(specialistSchema) }),
  },
  specialists_save: {
    // `replaces` is the previous name when an edit renames the specialist.
    input: z.object({
      specialist: specialistSchema,
      replaces: z.string().nullable(),
    }),
    output: specialistSchema,
  },
  specialists_remove: {
    input: z.object({ name: z.string() }),
    output: z.object({ removed: z.boolean() }),
  },
  // For other plugins: hands work to a specialist in a thread with no
  // parent. The caller tracks the returned thread and reads its result.
  specialists_handoff: {
    input: handoffInputSchema,
    output: z.object({ threadId: z.string() }),
  },
  // Versioned, idempotent handoff used by Envoy readiness monitors.
  specialists_handoff_capabilities: {
    input: z.null(),
    output: z.object({ keyedHandoffVersion: z.literal(1) }),
  },
  specialists_handoff_keyed: {
    input: handoffInputSchema.extend({
      handoffKey: z.string().min(1).max(200),
      parentThreadId: z.string(),
      // Explicit user-confirmed recovery after a fresh search finds no worker.
      relaunchUncertain: z.boolean().default(false),
    }),
    output: keyedHandoffResultSchema,
  },
  // Seeds the model picker for a new specialist.
  default_model: {
    input: z.null(),
    output: modelSelectionSchema.nullable(),
  },
});

/** Realtime channel app.tsx listens on. */
const SPECIALISTS_CHANGED = "specialists-changed";
const MAX_TASK_CHARS = 100_000;

function normalizeName(raw: string): string {
  return raw.trim().replace(/^@/u, "").toLowerCase();
}

function handoffTitle(specialist: Specialist, task: string): string {
  const firstLine = task.trim().split("\n", 1)[0] ?? "";
  const summary =
    firstLine.length > 60 ? `${firstLine.slice(0, 59)}…` : firstLine;
  return `${specialist.name}: ${summary}`;
}

function handoffPrompt(
  specialist: Specialist,
  task: string,
  parentThreadId: string | null,
  requestedBy: string | null = null,
): string {
  const from =
    parentThreadId !== null
      ? `Thread ${parentThreadId} handed you the task below. You share its workspace, so its files and uncommitted changes are visible to you.`
      : `${requestedBy ?? "A user"} handed you the task below.`;
  return [
    specialist.prompt,
    "---",
    `You are the "${specialist.name}" specialist. ${from} You have none of the requester's conversation history: work from the task and the workspace. End with one final message that states your result in full, because that message is what gets reported back.`,
    "## Task",
    task.trim(),
  ].join("\n\n");
}

function mentionContext(specialist: Specialist): string {
  const about =
    specialist.description === "" ? "" : ` (${specialist.description})`;
  return [
    `The user mentioned the specialist agent @${specialist.name}${about}. This is a request to delegate: hand the work the user is describing to that specialist instead of doing it yourself.`,
    `Call the \`specialist_handoff\` tool with specialist "${specialist.name}" and a task brief. If that tool is not available in this session, run \`bb specialists handoff ${specialist.name} --task "<brief>"\`.`,
    'The specialist runs in a new thread that shares this workspace but sees none of this conversation. Write the brief to stand alone: the goal, the relevant paths, exactly what to look at (for example "the unstaged changes, via git diff"), any constraints, and the result you want back.',
    "The specialist runs on its own configured model. Only if the user explicitly asks for a different model, provider, or reasoning level for this request, pass it as the tool's `model`, `provider`, or `reasoningLevel` (CLI: `--model`, `--provider`, `--reasoning-level`). Never change it on your own.",
    "After handing off, tell the user which thread is working on it, referencing it as @thread:<id>. You are notified when that thread finishes; then read its result with `bb thread output <id>` and relay it.",
  ].join("\n\n");
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    childNotifications: {
      type: "select",
      label: "Specialist thread notifications",
      description:
        "Push notification level for specialist threads spawned by another thread or plugin, such as a sage. The requester summarizes their output, so they are muted by default. Inherit uses the Push notifications plugin's child thread setting.",
      options: ["muted", "input-only", "all", "inherit"],
      default: "muted",
    },
  });

  /** Applies the configured level through bb's push-notifications plugin. */
  async function setChildNotifications(threadId: string): Promise<void> {
    const { childNotifications: level } = await settings.get();
    if (level === "inherit") return;
    try {
      await bb.sdk.plugins.callRpc({
        pluginId: "push-notifications",
        method: "threadNotifications.set",
        input: { threadId, level },
        outputSchema: z.unknown(),
      });
    } catch (cause) {
      // Notifications are a nicety; never fail the handoff over them.
      bb.log.warn(
        `could not set notifications to ${level} on ${threadId}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  async function readSpecialists(): Promise<Specialist[]> {
    // Persisted values are untrusted: drop rows that no longer parse.
    const stored = (await bb.storage.kv.get<unknown>("specialists")) ?? [];
    if (!Array.isArray(stored)) return [];
    return stored.flatMap((row) => {
      const parsed = specialistSchema.safeParse(row);
      return parsed.success ? [parsed.data] : [];
    });
  }
  async function writeSpecialists(specialists: Specialist[]): Promise<void> {
    await bb.storage.kv.set("specialists", specialists);
    bb.realtime.publish(SPECIALISTS_CHANGED, { count: specialists.length });
  }
  async function findSpecialist(rawName: string): Promise<Specialist | null> {
    const name = normalizeName(rawName);
    const specialists = await readSpecialists();
    return specialists.find((candidate) => candidate.name === name) ?? null;
  }
  async function unknownSpecialistMessage(rawName: string): Promise<string> {
    const names = (await readSpecialists()).map((each) => each.name);
    return names.length === 0
      ? `No specialist named "${rawName}". None are set up yet: add one on the Specialists page.`
      : `No specialist named "${rawName}". Available: ${names.join(", ")}.`;
  }

  async function saveSpecialist(
    specialist: Specialist,
    replaces: string | null,
  ): Promise<Specialist> {
    const specialists = await readSpecialists();
    const previousName = replaces === null ? null : normalizeName(replaces);
    const clash = specialists.some(
      (each) => each.name === specialist.name && each.name !== previousName,
    );
    if (clash) {
      throw new Error(`A specialist named "${specialist.name}" already exists`);
    }
    const index = specialists.findIndex((each) => each.name === previousName);
    if (index === -1) specialists.push(specialist);
    else specialists[index] = specialist;
    await writeSpecialists(specialists);
    return specialist;
  }
  async function removeSpecialist(rawName: string): Promise<boolean> {
    const name = normalizeName(rawName);
    const specialists = await readSpecialists();
    const remaining = specialists.filter((each) => each.name !== name);
    if (remaining.length === specialists.length) return false;
    await writeSpecialists(remaining);
    return true;
  }

  /** Spawns the specialist's thread and returns its id. */
  async function handoff(args: {
    specialist: Specialist;
    task: string;
    threadId: string | null;
    projectId: string | null;
    /** The workspace to share when there is no parent thread. */
    environmentId?: string | null;
    requestedBy?: string;
    override?: ModelOverride;
    /** Another plugin reports the result, as a parent thread would. */
    reportedByCaller?: boolean;
    handoffKey?: string;
    beforeSpawn?: () => void;
  }): Promise<string> {
    const { specialist, task } = args;
    const execution = resolveExecution(specialist, args.override ?? {});
    const parent =
      args.threadId === null
        ? null
        : await bb.sdk.threads.get({ threadId: args.threadId });
    const projectId = parent?.projectId ?? args.projectId;
    if (projectId === null) {
      throw new Error(
        "A handoff needs a thread or project to run in. Run it from a BB thread.",
      );
    }
    const environmentId = parent?.environmentId ?? args.environmentId ?? null;
    args.beforeSpawn?.();
    const thread = await bb.sdk.threads.spawn({
      projectId,
      environment:
        environmentId === null
          ? { type: "project-default" }
          : { type: "reuse", environmentId },
      ...(parent === null ? {} : { parentThreadId: parent.id }),
      ...(execution.providerId === null
        ? {}
        : { providerId: execution.providerId }),
      ...(execution.model === null ? {} : { model: execution.model }),
      ...(execution.reasoningLevel === null
        ? {}
        : { reasoningLevel: execution.reasoningLevel }),
      permissionMode: specialist.permissionMode,
      executionInputSources: {
        permissionMode: "explicit" as const,
        ...(execution.providerId ? { providerId: "explicit" as const } : {}),
        ...(execution.model ? { model: "explicit" as const } : {}),
        ...(execution.reasoningLevel
          ? { reasoningLevel: "explicit" as const }
          : {}),
      },
      title: handoffTitle(specialist, task),
      prompt: handoffPrompt(
        specialist,
        task,
        parent?.id ?? null,
        args.requestedBy ?? null,
      ),
      pluginMetadata: {
        specialist: specialist.name,
        ...(args.handoffKey === undefined
          ? {}
          : { handoffKey: args.handoffKey }),
        ...(args.override === undefined ||
        Object.keys(args.override).length === 0
          ? {}
          : { override: args.override }),
      },
    });
    if (parent !== null || args.reportedByCaller === true) {
      await setChildNotifications(thread.id);
    }
    bb.log.info(
      `handed off to ${specialist.name} on ${describeModel(execution)}: ${thread.id}`,
    );
    return thread.id;
  }

  function handoffReceipt(
    specialist: Specialist,
    threadId: string,
    execution: Pick<Specialist, "providerId" | "model" | "reasoningLevel">,
  ): string {
    return [
      `Handed off to @${specialist.name} on ${describeModel(execution)} in thread ${threadId} (reference it to the user as @thread:${threadId}).`,
      `You are notified when it finishes. Then read its result with \`bb thread output ${threadId}\` and relay it to the user. Do not do the handed-off work yourself in the meantime.`,
    ].join("\n");
  }

  const handoffDb = bb.storage.database();
  handoffDb.exec(
    "CREATE TABLE IF NOT EXISTS keyed_handoffs (key TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT NOT NULL, status TEXT NOT NULL, thread_id TEXT, error TEXT)",
  );
  const handoffQueues = new Map<string, Promise<KeyedHandoffResult>>();
  async function findKeyedWorker(projectId: string, key: string) {
    for (const archived of [false, true]) {
      for (let offset = 0; ; offset += 100) {
        const threads = await bb.sdk.threads.list({
          projectId,
          originPluginId: "specialists",
          includeHidden: true,
          archived,
          limit: 100,
          offset,
        });
        if (!threads.length) break;
        const batch = await bb.sdk.threads.experimental_listPluginMetadata({
          pluginId: "specialists",
          threadIds: threads.map((t) => t.id),
        });
        const match = batch.threads.find((t) => t.metadata.handoffKey === key);
        if (match) return match.threadId;
        if (threads.length < 100) break;
      }
    }
    return null;
  }
  function keyedHandoff(
    input: z.infer<typeof handoffInputSchema> & {
      handoffKey: string;
      parentThreadId: string;
      relaunchUncertain: boolean;
    },
  ): Promise<KeyedHandoffResult> {
    const { handoffKey: key, projectId, parentThreadId } = input;
    const run = async (): Promise<KeyedHandoffResult> => {
      const stored = handoffDb
        .prepare("SELECT * FROM keyed_handoffs WHERE key=?")
        .get(key) as
        | {
            project_id: string;
            parent_id: string;
            status: string;
            thread_id: string | null;
            error: string | null;
          }
        | undefined;
      if (
        stored &&
        (stored.project_id !== projectId || stored.parent_id !== parentThreadId)
      )
        throw new Error("That handoff key belongs to a different task");
      const save = (
        status: "reserved" | KeyedHandoffResult["status"],
        threadId: string | null,
        error: string | null,
      ) => {
        handoffDb
          .prepare(
            "INSERT INTO keyed_handoffs (key,project_id,parent_id,status,thread_id,error) VALUES (?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET status=excluded.status,thread_id=excluded.thread_id,error=excluded.error",
          )
          .run(key, projectId, parentThreadId, status, threadId, error);
      };
      if (stored?.status === "started")
        return { status: "started", threadId: stored.thread_id, error: null };
      const previous = await findKeyedWorker(projectId, key);
      if (previous) {
        save("started", previous, null);
        return { status: "started", threadId: previous, error: null };
      }
      if (stored?.status === "uncertain" && !input.relaunchUncertain)
        return {
          status: "uncertain",
          threadId: null,
          error:
            "The spawn outcome is unconfirmed. Recovery found no worker yet; no duplicate will be launched.",
        };
      save("reserved", null, null);
      let spawnAttempted = false;
      try {
        const specialist = await findSpecialist(input.specialist);
        if (!specialist)
          throw new Error(await unknownSpecialistMessage(input.specialist));
        const threadId = await handoff({
          specialist,
          task: input.task,
          threadId: parentThreadId,
          projectId,
          environmentId: input.environmentId,
          requestedBy: input.requestedBy,
          override: input.override,
          handoffKey: key,
          reportedByCaller: true,
          beforeSpawn() {
            spawnAttempted = true;
            save("uncertain", null, null);
          },
        });
        save("started", threadId, null);
        return { status: "started", threadId, error: null };
      } catch (error) {
        const value = error as {
          status?: unknown;
          statusCode?: unknown;
        } | null;
        const rejected =
          error instanceof z.ZodError ||
          (value &&
            [400, 401, 403, 404, 409, 422].includes(
              Number(value.status ?? value.statusCode),
            ));
        const status = !spawnAttempted || rejected ? "failed" : "uncertain";
        const message = error instanceof Error ? error.message : String(error);
        save(status, null, message);
        return { status, threadId: null, error: message };
      }
    };
    const next = (handoffQueues.get(key) ?? Promise.resolve()).then(run, run);
    handoffQueues.set(key, next);
    void next
      .finally(() => {
        if (handoffQueues.get(key) === next) handoffQueues.delete(key);
      })
      .catch(() => {});
    return next;
  }

  bb.rpc.register(rpcContract, {
    specialists_handoff_capabilities: () => ({
      keyedHandoffVersion: 1 as const,
    }),
    specialists_handoff_keyed: keyedHandoff,
    specialists_list: async () => ({ specialists: await readSpecialists() }),
    specialists_save: ({ specialist, replaces }) =>
      saveSpecialist(specialist, replaces),
    specialists_remove: async ({ name }) => ({
      removed: await removeSpecialist(name),
    }),
    specialists_handoff: async ({
      specialist: name,
      task,
      projectId,
      environmentId,
      requestedBy,
      parentThreadId,
      handoffKey,
      override,
    }) => {
      const specialist = await findSpecialist(name);
      if (specialist === null) {
        throw new Error(await unknownSpecialistMessage(name));
      }
      const threadId = await handoff({
        specialist,
        task,
        threadId: parentThreadId ?? null,
        projectId,
        environmentId,
        requestedBy,
        handoffKey,
        ...(override === undefined ? {} : { override }),
        reportedByCaller: true,
      });
      return { threadId };
    },
    default_model: async () => {
      const providers = await bb.sdk.providers.list();
      const provider =
        providers.find((each) => each.id === "claude-code" && each.available) ??
        providers.find((each) => each.available);
      if (provider === undefined) return null;
      const { models } = await bb.sdk.providers.models({
        providerId: provider.id,
      });
      const model = models.find((each) => each.isDefault) ?? models[0];
      if (model === undefined) return null;
      const reasoningLevel = REASONING_LEVELS.find(
        (level) => level === model.defaultReasoningEffort,
      );
      return {
        providerId: provider.id,
        model: model.model,
        reasoningLevel: reasoningLevel ?? "medium",
      };
    },
  });

  bb.ui.registerMentionProvider({
    id: "specialist",
    label: "Specialists",
    async search({ query }) {
      const needle = query.trim().toLowerCase();
      const specialists = await readSpecialists();
      return specialists
        .filter(
          (each) =>
            each.name.includes(needle) ||
            each.description.toLowerCase().includes(needle),
        )
        .map((each) => ({
          id: each.name,
          title: each.name,
          ...(each.description === "" ? {} : { subtitle: each.description }),
          icon: "Bot",
        }));
    },
    // Runs at send time; a throw blocks the send with this message.
    async resolve(itemId) {
      const specialist = await findSpecialist(itemId);
      if (specialist === null) {
        throw new Error(await unknownSpecialistMessage(itemId));
      }
      return { context: mentionContext(specialist) };
    },
  });

  bb.agents.registerTool({
    name: "specialist_handoff",
    description:
      "Hand work off to a specialist agent. Spawns a child thread that runs the specialist on its own model in this thread's workspace, and returns that thread's id. Use it when the user @mentions a specialist or asks for one by name.",
    presentation: {
      label: {
        pending: "Handing off to specialist",
        completed: "Handed off to specialist",
      },
    },
    parameters: z.object({
      specialist: z
        .string()
        .min(1)
        .describe("The specialist's name, as mentioned (without the @)."),
      task: z
        .string()
        .trim()
        .min(1)
        .max(MAX_TASK_CHARS)
        .describe(
          "A self-contained brief. The specialist sees this workspace but none of this conversation: give the goal, relevant paths, what to inspect, constraints, and the result you want back.",
        ),
      model: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe(
          "Only when the user explicitly asks for it: a model id for this handoff only (see `bb provider models <provider>`). Omit to use the specialist's model.",
        ),
      provider: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe(
          "Only when the user explicitly asks for it: a provider id for this handoff only (see `bb provider list`). Omit to keep the specialist's provider.",
        ),
      reasoningLevel: z
        .enum(REASONING_LEVELS)
        .optional()
        .describe(
          "Only when the user explicitly asks for it: a reasoning level for this handoff only. Omit to use the specialist's.",
        ),
    }),
    async execute(
      { specialist: name, task, model, provider, reasoningLevel },
      { threadId, projectId },
    ) {
      const specialist = await findSpecialist(name);
      if (specialist === null) {
        return {
          content: [
            { type: "text", text: await unknownSpecialistMessage(name) },
          ],
          isError: true,
        };
      }
      const override = {
        ...(provider === undefined ? {} : { providerId: provider }),
        ...(model === undefined ? {} : { model }),
        ...(reasoningLevel === undefined ? {} : { reasoningLevel }),
      };
      const childId = await handoff({
        specialist,
        task,
        threadId,
        projectId,
        override,
      });
      return handoffReceipt(
        specialist,
        childId,
        resolveExecution(specialist, override),
      );
    },
  });

  function describeModel(
    specialist: Pick<Specialist, "providerId" | "model" | "reasoningLevel">,
  ): string {
    if (specialist.model === null) return "project default";
    const provider =
      specialist.providerId === null ? "" : `${specialist.providerId}/`;
    const reasoning =
      specialist.reasoningLevel === null
        ? ""
        : ` (${specialist.reasoningLevel})`;
    return `${provider}${specialist.model}${reasoning}`;
  }
  async function requireSpecialist(rawName: string): Promise<Specialist> {
    const specialist = await findSpecialist(rawName);
    if (specialist === null) {
      throw new PluginCliError(await unknownSpecialistMessage(rawName), {
        code: "specialist_not_found",
        hint: "Run `bb specialists list` to see the names.",
      });
    }
    return specialist;
  }
  const jsonOption = {
    type: "boolean",
    description: "Emit machine-readable JSON",
  } as const;
  const nameArg = {
    name: "name",
    description: "Specialist name (a leading @ is ignored)",
    required: true,
  } as const;

  bb.cli.register(
    defineCli({
      name: "specialists",
      summary: "Manage specialist agents and hand work off to them",
      commands: {
        list: cliCommand({
          summary: "List specialists",
          options: { json: jsonOption },
          async run(input) {
            const specialists = await readSpecialists();
            if (input.options.json) {
              return { exitCode: 0, stdout: JSON.stringify(specialists) };
            }
            return {
              exitCode: 0,
              stdout:
                specialists.length === 0
                  ? "No specialists. Add one on the Specialists page or with `bb specialists add`."
                  : specialists
                      .map(
                        (each) =>
                          `@${each.name}  [${describeModel(each)}, ${each.permissionMode}]  ${each.description}`,
                      )
                      .join("\n"),
            };
          },
        }),
        show: cliCommand({
          summary: "Show one specialist, including its prompt",
          positionals: [nameArg],
          options: { json: jsonOption },
          async run(input) {
            const specialist = await requireSpecialist(input.positionals.name);
            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify(specialist)
                : [
                    `@${specialist.name}`,
                    `Description: ${specialist.description}`,
                    `Model: ${describeModel(specialist)}`,
                    `Permissions: ${specialist.permissionMode}`,
                    "",
                    specialist.prompt,
                  ].join("\n"),
            };
          },
        }),
        add: cliCommand({
          summary: "Add a specialist, or replace the one with the same name",
          positionals: [nameArg],
          options: {
            description: {
              type: "string",
              description:
                "One line on what the specialist is for (max 300 chars)",
              default: "",
            },
            prompt: {
              type: "string",
              description:
                "The specialist's standing instructions (may span lines)",
              required: true,
            },
            provider: {
              type: "string",
              description:
                "Provider id (see `bb provider list`); omit for the project default",
            },
            model: {
              type: "string",
              description:
                "Model id (see `bb provider models`); omit for the project default",
            },
            "reasoning-level": {
              type: "enum",
              values: REASONING_LEVELS,
              aliases: ["reasoning", "effort"],
              description: "Reasoning level; omit for the model default",
            },
            "permission-mode": {
              type: "enum",
              values: PERMISSION_MODES,
              aliases: ["permissions"],
              description:
                "What the specialist's thread may do without asking",
              default: "full",
            },
            json: jsonOption,
          },
          async run(input) {
            const parsed = specialistSchema.safeParse({
              name: normalizeName(input.positionals.name),
              description: input.options.description,
              prompt: input.options.prompt,
              providerId: input.options.provider ?? null,
              model: input.options.model ?? null,
              reasoningLevel: input.options["reasoning-level"] ?? null,
              permissionMode: input.options["permission-mode"],
            });
            if (!parsed.success) {
              throw new PluginCliError(
                parsed.error.issues[0]?.message ?? "Invalid specialist",
                { code: "invalid_value" },
              );
            }
            const saved = await saveSpecialist(parsed.data, parsed.data.name);
            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify(saved)
                : `Saved @${saved.name} [${describeModel(saved)}]`,
            };
          },
        }),
        remove: cliCommand({
          summary: "Remove a specialist",
          positionals: [nameArg],
          options: { json: jsonOption },
          async run(input) {
            const specialist = await requireSpecialist(input.positionals.name);
            await removeSpecialist(specialist.name);
            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify({ removed: true, name: specialist.name })
                : `Removed @${specialist.name}`,
            };
          },
        }),
        handoff: cliCommand({
          summary:
            "Spawn a thread that runs a specialist on a task, as a child of the current thread",
          positionals: [nameArg],
          options: {
            task: {
              type: "string",
              description:
                "Self-contained task brief, may span lines (max 100000 chars)",
              aliases: ["prompt", "brief"],
              required: true,
            },
            provider: {
              type: "string",
              description:
                "Provider id for this handoff only; omit to keep the specialist's",
            },
            model: {
              type: "string",
              description:
                "Model id for this handoff only; omit to use the specialist's (a new --provider without --model uses that provider's default)",
            },
            "reasoning-level": {
              type: "enum",
              values: REASONING_LEVELS,
              aliases: ["reasoning", "effort"],
              description:
                "Reasoning level for this handoff only; omit to use the specialist's",
            },
            json: jsonOption,
          },
          async run(input, ctx) {
            const specialist = await requireSpecialist(input.positionals.name);
            const task = input.options.task.trim();
            if (task === "" || task.length > MAX_TASK_CHARS) {
              throw new PluginCliError(
                `--task must be 1-${MAX_TASK_CHARS} characters`,
                { code: "invalid_value" },
              );
            }
            if (ctx.threadId === undefined && ctx.projectId === undefined) {
              throw new PluginCliError(
                "A handoff needs a thread or project to run in.",
                {
                  code: "no_thread",
                  hint: "Run this from inside a BB thread.",
                },
              );
            }
            const { provider, model } = input.options;
            const reasoningLevel = input.options["reasoning-level"];
            const override = {
              ...(provider === undefined ? {} : { providerId: provider }),
              ...(model === undefined ? {} : { model }),
              ...(reasoningLevel === undefined ? {} : { reasoningLevel }),
            };
            const threadId = await handoff({
              specialist,
              task,
              threadId: ctx.threadId ?? null,
              projectId: ctx.projectId ?? null,
              override,
            });
            const execution = resolveExecution(specialist, override);
            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify({
                    threadId,
                    specialist: specialist.name,
                    ...execution,
                  })
                : handoffReceipt(specialist, threadId, execution),
            };
          },
        }),
      },
    }),
  );
}
