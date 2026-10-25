import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

const hosts = [
  { id: "host-laptop", name: "Laptop" },
  { id: "host-studio", name: "Studio" },
];

async function setup(environment: Record<string, unknown>) {
  const host = createFakePluginHost({
    pluginId: "specialists",
    sdk: {
      hosts: { list: async () => hosts as any },
      environments: {
        get: async () =>
          ({ id: "env-1", hostId: "host-laptop", ...environment }) as any,
      },
      threads: {
        get: async ({ threadId }) =>
          makeThreadResponse({
            id: threadId,
            projectId: "project-1",
            environmentId: "env-1",
          }),
        spawn: async () =>
          makeThreadResponse({ id: "worker-1", projectId: "project-1" }),
      },
      plugins: { callRpc: async () => ({ ok: true }) },
    },
  });
  await plugin(host.bb);
  const save = (hostId: string | null) =>
    host.harness.behavior.callRpc("specialists_save", {
      specialist: {
        name: "reviewer",
        description: "",
        prompt: "Review",
        providerId: null,
        model: null,
        reasoningLevel: null,
        hostId,
      },
      replaces: "reviewer",
    });
  const handoff = async (machine?: string) => {
    await host.harness.behavior.callRpc("specialists_handoff", {
      specialist: "reviewer",
      task: "Review it",
      projectId: "project-1",
      environmentId: null,
      requestedBy: "Test",
      parentThreadId: "parent-1",
      ...(machine === undefined ? {} : { machine }),
    });
    const calls = host.harness.inspection.sdk.callsTo("threads.spawn");
    return calls[calls.length - 1]![0] as any;
  };
  return { host, save, handoff };
}

test("no machine, or the requester's machine, reuses the requester's workspace", async () => {
  const { host, save, handoff } = await setup({ isWorktree: true });
  try {
    await save(null);
    assert.deepEqual((await handoff()).environment, {
      type: "reuse",
      environmentId: "env-1",
    });
    assert.deepEqual((await handoff("laptop")).environment, {
      type: "reuse",
      environmentId: "env-1",
    });
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a pinned specialist runs on its machine; a per-handoff machine overrides it", async () => {
  const { host, save, handoff } = await setup({ isWorktree: true });
  try {
    await save("host-studio");
    const pinned = await handoff();
    assert.deepEqual(pinned.environment, {
      type: "host",
      hostId: "host-studio",
      workspace: { type: "managed-worktree", baseBranch: { kind: "default" } },
    });
    assert.match(pinned.prompt, /machine "Studio"/);
    assert.equal(pinned.pluginMetadata.hostId, "host-studio");
    assert.equal((await handoff("host-laptop")).environment.type, "reuse");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("cross-machine workspace kind follows the requester's", async () => {
  for (const [environment, workspace] of [
    [{ environmentProviderId: "personal-workspace" }, { type: "personal" }],
    [{ isWorktree: false }, { type: "unmanaged", path: null }],
  ] as const) {
    const { host, save, handoff } = await setup(environment);
    try {
      await save(null);
      assert.deepEqual((await handoff("Studio")).environment.workspace, workspace);
    } finally {
      await host.harness.lifecycle.dispose();
    }
  }
});

test("an unknown machine fails the handoff", async () => {
  const { host, save, handoff } = await setup({});
  try {
    await save(null);
    await assert.rejects(handoff("nowhere"), /No machine "nowhere"/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});
