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
});
export type Specialist = z.infer<typeof specialistSchema>;

const modelSelectionSchema = z.object({
  providerId: z.string(),
  model: z.string(),
  reasoningLevel: z.enum(REASONING_LEVELS),
});

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
    input: z.object({
      specialist: z.string(),
      task: z.string().trim().min(1).max(100_000),
      projectId: z.string(),
      // The workspace to share; null runs in the project's default.
      environmentId: z.string().nullable(),
      // Who is asking, as the specialist should read it, e.g. "The sage X".
      requestedBy: z.string().trim().min(1).max(200),
    }),
    output: z.object({ threadId: z.string() }),
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
    "The specialist runs in a new thread that shares this workspace but sees none of this conversation. Write the brief to stand alone: the goal, the relevant paths, exactly what to look at (for example \"the unstaged changes, via git diff\"), any constraints, and the result you want back.",
    "After handing off, tell the user which thread is working on it, referencing it as @thread:<id>. You are notified when that thread finishes; then read its result with `bb thread output <id>` and relay it.",
  ].join("\n\n");
}

export default async function plugin(bb: BbPluginApi) {
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
  }): Promise<string> {
    const { specialist, task } = args;
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
    const environmentId =
      parent?.environmentId ?? args.environmentId ?? null;
    const thread = await bb.sdk.threads.spawn({
      projectId,
      environment:
        environmentId === null
          ? { type: "project-default" }
          : { type: "reuse", environmentId },
      ...(parent === null ? {} : { parentThreadId: parent.id }),
      ...(specialist.providerId === null
        ? {}
        : { providerId: specialist.providerId }),
      ...(specialist.model === null ? {} : { model: specialist.model }),
      ...(specialist.reasoningLevel === null
        ? {}
        : { reasoningLevel: specialist.reasoningLevel }),
      title: handoffTitle(specialist, task),
      prompt: handoffPrompt(
        specialist,
        task,
        parent?.id ?? null,
        args.requestedBy ?? null,
      ),
      pluginMetadata: { specialist: specialist.name },
    });
    bb.log.info(`handed off to ${specialist.name}: ${thread.id}`);
    return thread.id;
  }

  function handoffReceipt(specialist: Specialist, threadId: string): string {
    return [
      `Handed off to @${specialist.name} in thread ${threadId} (reference it to the user as @thread:${threadId}).`,
      `You are notified when it finishes. Then read its result with \`bb thread output ${threadId}\` and relay it to the user. Do not do the handed-off work yourself in the meantime.`,
    ].join("\n");
  }

  bb.rpc.register(rpcContract, {
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
    }) => {
      const specialist = await findSpecialist(name);
      if (specialist === null) {
        throw new Error(await unknownSpecialistMessage(name));
      }
      const threadId = await handoff({
        specialist,
        task,
        threadId: null,
        projectId,
        environmentId,
        requestedBy,
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
    }),
    async execute({ specialist: name, task }, { threadId, projectId }) {
      const specialist = await findSpecialist(name);
      if (specialist === null) {
        return {
          content: [
            { type: "text", text: await unknownSpecialistMessage(name) },
          ],
          isError: true,
        };
      }
      const childId = await handoff({ specialist, task, threadId, projectId });
      return handoffReceipt(specialist, childId);
    },
  });

  function describeModel(specialist: Specialist): string {
    if (specialist.model === null) return "project default";
    const provider =
      specialist.providerId === null ? "" : `${specialist.providerId}/`;
    const reasoning =
      specialist.reasoningLevel === null ? "" : ` (${specialist.reasoningLevel})`;
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
                          `@${each.name}  [${describeModel(each)}]  ${each.description}`,
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
              description: "One line on what the specialist is for (max 300 chars)",
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
              description: "Provider id (see `bb provider list`); omit for the project default",
            },
            model: {
              type: "string",
              description: "Model id (see `bb provider models`); omit for the project default",
            },
            "reasoning-level": {
              type: "enum",
              values: REASONING_LEVELS,
              aliases: ["reasoning", "effort"],
              description: "Reasoning level; omit for the model default",
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
            const threadId = await handoff({
              specialist,
              task,
              threadId: ctx.threadId ?? null,
              projectId: ctx.projectId ?? null,
            });
            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify({ threadId, specialist: specialist.name })
                : handoffReceipt(specialist, threadId),
            };
          },
        }),
      },
    }),
  );
}
