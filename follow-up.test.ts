import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

async function setup() {
  let spawns = 0;
  const threads = new Map<string, ReturnType<typeof makeThreadResponse>>();
  const metadata = new Map<string, Record<string, unknown>>();
  const host = createFakePluginHost({
    pluginId: "specialists",
    sdk: {
      threads: {
        get: async ({ threadId }) =>
          threads.get(threadId) ??
          makeThreadResponse({
            id: threadId,
            projectId: "project-1",
            environmentId: "env-1",
          }),
        experimental_listPluginMetadata: async ({ threadIds }) => ({
          threads: threadIds.map((threadId) => ({
            threadId,
            metadata: metadata.get(threadId) ?? {},
          })),
        }),
        spawn: async (args) => {
          spawns++;
          const thread = makeThreadResponse({
            id: `worker-${spawns}`,
            projectId: "project-1",
            environmentId: "env-1",
            parentThreadId: args.parentThreadId ?? null,
            originPluginId: "specialists",
          });
          threads.set(thread.id, thread);
          metadata.set(thread.id, args.pluginMetadata as Record<string, unknown>);
          return thread;
        },
        send: async () => ({}) as any,
      },
      plugins: { callRpc: async () => ({ ok: true }) },
    },
  });
  await plugin(host.bb);
  for (const name of ["device-validator", "reviewer"]) {
    await host.harness.behavior.callRpc("specialists_save", {
      specialist: {
        name,
        description: "",
        prompt: "Validate",
        providerId: null,
        model: null,
        reasoningLevel: null,
      },
      replaces: null,
    });
  }
  const call = (input: Record<string, unknown>, threadId = "parent-1") =>
    host.harness.behavior.callAgentTool("specialist_handoff", input, {
      threadId,
      projectId: "project-1",
    });
  const text = (result: unknown) =>
    typeof result === "string"
      ? result
      : (result as { content: { text: string }[] }).content[0]!.text;
  return { host, call, text, spawns: () => spawns };
}

test("a follow-up with `thread` goes to the same specialist thread instead of spawning", async () => {
  const s = await setup();
  try {
    const first = s.text(
      await s.call({ specialist: "device-validator", task: "Set up a device" }),
    );
    assert.match(first, /thread: "worker-1"/);
    const second = await s.call({
      specialist: "device-validator",
      task: "Screenshot the profile",
      thread: "worker-1",
    });
    assert.match(s.text(second), /Sent the follow-up .* worker-1/);
    assert.equal(s.spawns(), 1);
    const sends = s.host.harness.inspection.sdk.callsTo("threads.send");
    assert.equal(sends.length, 1);
    const sent = sends[0]![0] as any;
    assert.equal(sent.threadId, "worker-1");
    assert.equal(sent.mode, "queue-if-active");
    assert.equal(sent.senderThreadId, "parent-1");
    assert.match(sent.input[0].text, /Screenshot the profile/);
  } finally {
    await s.host.harness.lifecycle.dispose();
  }
});

test("a follow-up is refused for another specialist's or another caller's thread", async () => {
  const s = await setup();
  try {
    await s.call({ specialist: "device-validator", task: "Set up a device" });
    const wrongSpecialist = (await s.call({
      specialist: "reviewer",
      task: "Review",
      thread: "worker-1",
    })) as any;
    assert.equal(wrongSpecialist.isError, true);
    assert.match(s.text(wrongSpecialist), /not a @reviewer handoff/);
    const wrongCaller = (await s.call(
      { specialist: "device-validator", task: "Again", thread: "worker-1" },
      "someone-else",
    )) as any;
    assert.equal(wrongCaller.isError, true);
    assert.match(s.text(wrongCaller), /another thread/);
    const withModel = (await s.call({
      specialist: "device-validator",
      task: "Again",
      thread: "worker-1",
      model: "other",
    })) as any;
    assert.equal(withModel.isError, true);
    assert.equal(s.host.harness.inspection.sdk.callsTo("threads.send").length, 0);
    assert.equal(s.spawns(), 1);
  } finally {
    await s.host.harness.lifecycle.dispose();
  }
});
