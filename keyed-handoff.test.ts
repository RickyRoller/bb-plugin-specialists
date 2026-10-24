import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

const input = {
  specialist: "pr-handoff",
  task: "Review the task PR",
  projectId: "project-1",
  environmentId: "env-1",
  parentThreadId: "parent-1",
  requestedBy: "Envoy",
  handoffKey: "envoy-pr:task-1:owner/repo:1",
};
async function setup() {
  let mode = "ok";
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
        list: async (args) => (args?.archived ? [] : [...threads.values()]),
        experimental_listPluginMetadata: async ({ threadIds }) => ({
          threads: threadIds.map((threadId) => ({
            threadId,
            metadata: metadata.get(threadId) ?? {},
          })),
        }),
        spawn: async (args) => {
          spawns++;
          if (mode === "reject")
            throw Object.assign(new Error("Model rejected"), { status: 400 });
          if (mode === "lost-before-commit")
            throw new Error("Connection lost; outcome unknown");
          const thread = makeThreadResponse({
            id: `worker-${spawns}`,
            projectId: "project-1",
            environmentId: "env-1",
            parentThreadId: args.parentThreadId ?? null,
            originPluginId: "specialists",
          });
          threads.set(thread.id, thread);
          metadata.set(
            thread.id,
            args.pluginMetadata as Record<string, unknown>,
          );
          if (mode === "lost-after-commit")
            throw new Error("Response lost after commit");
          return thread;
        },
      },
      plugins: { callRpc: async () => ({ ok: true }) },
    },
  });
  await plugin(host.bb);
  await host.harness.behavior.callRpc("specialists_save", {
    specialist: {
      name: "pr-handoff",
      description: "PR monitor",
      prompt: "Review",
      providerId: "claude-code",
      model: "lead-model",
      reasoningLevel: "high",
    },
    replaces: null,
  });
  return {
    ...host,
    setMode(value: string) {
      mode = value;
    },
    spawns: () => spawns,
    threads,
  };
}

test("keyed handoff serializes concurrent retries, records parent/key and execution provenance, and survives reload", async () => {
  const s = await setup();
  try {
    const [a, b] = (await Promise.all([
      s.harness.behavior.callRpc("specialists_handoff_keyed", input),
      s.harness.behavior.callRpc("specialists_handoff_keyed", input),
    ])) as any[];
    assert.equal(a.status, "started");
    assert.equal(a.threadId, b.threadId);
    assert.equal(s.spawns(), 1);
    const args = s.harness.inspection.sdk.callsTo(
      "threads.spawn",
    )[0]![0] as any;
    assert.equal(args.parentThreadId, "parent-1");
    assert.equal(args.pluginMetadata.handoffKey, input.handoffKey);
    // Saved without a permission mode, so it defaults to full access.
    assert.equal(args.permissionMode, "full");
    assert.deepEqual(args.executionInputSources, {
      permissionMode: "explicit",
      providerId: "explicit",
      model: "explicit",
      reasoningLevel: "explicit",
    });
    const fresh = await s.harness.lifecycle.reload(plugin);
    try {
      const recovered = (await fresh.harness.behavior.callRpc(
        "specialists_handoff_keyed",
        input,
      )) as any;
      assert.equal(recovered.threadId, a.threadId);
      assert.equal(s.spawns(), 1);
    } finally {
      await fresh.harness.lifecycle.dispose();
    }
  } finally {
    await s.harness.lifecycle.dispose();
  }
});

test("rejected spawn retries; lost reply after commit recovers; unconfirmed spawn never duplicates", async () => {
  for (const mode of ["reject", "lost-after-commit", "lost-before-commit"]) {
    const s = await setup();
    try {
      s.setMode(mode);
      const first = (await s.harness.behavior.callRpc(
        "specialists_handoff_keyed",
        input,
      )) as any;
      assert.equal(first.status, mode === "reject" ? "failed" : "uncertain");
      s.setMode("ok");
      const fresh = await s.harness.lifecycle.reload(plugin);
      try {
        const result = (await fresh.harness.behavior.callRpc(
          "specialists_handoff_keyed",
          input,
        )) as any;
        assert.equal(
          result.status,
          mode === "lost-before-commit" ? "uncertain" : "started",
        );
        assert.equal(s.spawns(), mode === "reject" ? 2 : 1);
      } finally {
        await fresh.harness.lifecycle.dispose();
      }
    } finally {
      await s.harness.lifecycle.dispose();
    }
  }
});

test("pre-spawn rejection is recoverable and one key cannot be reused for another parent", async () => {
  const s = await setup();
  try {
    await s.harness.behavior.callRpc("specialists_remove", {
      name: "pr-handoff",
    });
    const first = (await s.harness.behavior.callRpc(
      "specialists_handoff_keyed",
      input,
    )) as any;
    assert.equal(first.status, "failed");
    assert.equal(s.spawns(), 0);
    await s.harness.behavior.callRpc("specialists_save", {
      specialist: {
        name: "pr-handoff",
        description: "PR monitor",
        prompt: "Review",
        providerId: null,
        model: null,
        reasoningLevel: null,
      },
      replaces: null,
    });
    const result = (await s.harness.behavior.callRpc(
      "specialists_handoff_keyed",
      input,
    )) as any;
    assert.equal(result.status, "started");
    assert.equal(s.spawns(), 1);
    await assert.rejects(
      s.harness.behavior.callRpc("specialists_handoff_keyed", {
        ...input,
        parentThreadId: "other-parent",
      }),
      /different task/,
    );
  } finally {
    await s.harness.lifecycle.dispose();
  }
});

test("explicit uncertain relaunch searches for a committed worker before allowing another spawn", async () => {
  for (const mode of ["lost-before-commit", "lost-after-commit"]) {
    const s = await setup();
    try {
      s.setMode(mode);
      await s.harness.behavior.callRpc("specialists_handoff_keyed", input);
      s.setMode("ok");
      const result = (await s.harness.behavior.callRpc(
        "specialists_handoff_keyed",
        { ...input, relaunchUncertain: true },
      )) as any;
      assert.equal(result.status, "started");
      assert.equal(s.spawns(), mode === "lost-before-commit" ? 2 : 1);
      await s.harness.behavior.callRpc("specialists_handoff_keyed", input);
      assert.equal(s.spawns(), mode === "lost-before-commit" ? 2 : 1);
    } finally {
      await s.harness.lifecycle.dispose();
    }
  }
});
