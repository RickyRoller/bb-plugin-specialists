# bb-plugin-specialists

Specialist agents for BB. A specialist is a named preset with a description, a
prompt, and a model. Mention one in a message and the thread hands that work to
a new thread running the specialist.

```
ask the @reviewer to look over the unstaged changes
```

## Install

Clone the repository, then install it from your checkout:

```
git clone https://github.com/RickyRoller/bb-plugin-specialists.git
bb plugin install ./bb-plugin-specialists
```

## Set up a specialist

Open **Specialists** in the left sidebar and choose **New**, or use the CLI:

```
bb specialists add reviewer \
  --description "Reviews code changes for bugs and risky design" \
  --provider claude-code --model claude-opus-5-5 --reasoning-level high \
  --prompt "$(cat reviewer-prompt.md)"
```

Each specialist also has a permission mode: `full` (the default), `auto`, or
`accept-edits`. It sets what the specialist's thread may do without asking. Set
it in the dialog's **Permissions** picker or with `--permission-mode`.

## Pinning a specialist to a machine

With more than one machine enrolled, a specialist can run on a specific one.
Pick it in the dialog's **Machine** field or pass `--machine <id-or-name>` to
`bb specialists add`. With no machine it runs on the requester's machine.

To send one handoff elsewhere, ask for it in the message ("ask the @reviewer,
on the Studio machine, to …"). The tool takes an optional `machine`, the CLI
takes `--machine`, and the `specialists_handoff` RPCs take `machine`. It
accepts a machine id or an unambiguous name (see `bb machine list`).

When the specialist's machine is the requester's, it shares the requester's
workspace as usual. On another machine it gets a fresh workspace of the same
kind there: a personal workspace, a worktree of the default branch, or the
project's checkout on that machine. It does not see the requester's
uncommitted changes, and the project needs a source on that machine.

## What a mention does

1. The `@` menu in the composer lists specialists under **Specialists**.
2. On send, the mention attaches agent-only context that tells the thread's
   agent to delegate instead of doing the work.
3. The agent calls the `specialist_handoff` tool with a self-contained task
   brief. `bb specialists handoff` is the fallback for sessions that started
   before the plugin was installed.
4. The plugin spawns a child thread on the specialist's model. Its first
   message is the specialist's prompt followed by the task.
5. The child thread reuses the mentioning thread's environment, so it sees the
   same files and uncommitted changes, unless it runs on another machine.
6. BB notifies the parent thread when the child finishes. The parent reads the
   result and relays it.

## Overriding the model for one handoff

Ask for it in the message, for example "ask the @reviewer, on Sonnet, to look
over the unstaged changes". The agent passes the override to the handoff, and
the specialist's saved settings stay as they are.

- The tool takes optional `model`, `provider`, and `reasoningLevel`.
- The CLI takes `--model`, `--provider`, and `--reasoning-level`.
- The `specialists_handoff` RPC takes an optional `override` object with
  `providerId`, `model`, and `reasoningLevel`.

Omitted fields keep the specialist's values. Changing the provider without
naming a model uses that provider's default model. Model ids are not checked
against bb's model list, which can lag behind a provider's real models; an
unknown id fails when the thread starts.

## Constraints

- Agent tools load when a session starts. A thread that was already running
  when you installed the plugin uses the CLI fallback until its session
  restarts.
- The specialist shares the parent's workspace and can edit the same files.
  It runs with full access unless you pick a narrower permission mode. Say so
  in the specialist's prompt if it should only read.
- The specialist sees none of the parent's conversation, only the task brief.

## Develop

```
bb plugin dev          # rebuild and reload on save
npx tsc --noEmit       # typecheck
```

- `server.ts` holds storage, RPC, the mention provider, the agent tool, and the
  CLI.
- `app.tsx` holds the Specialists page.
- `skills/specialists/SKILL.md` tells agents how to hand off.


The `specialists_handoff` RPC also accepts optional `parentThreadId` and
`handoffKey` fields for plugin-owned work. A parent shares its workspace and
receives normal child reporting; the recovery key is stored in the child's
Specialists metadata so the caller can recover an interrupted response.
Existing callers may omit both fields.


For durable task handoffs, `specialists_handoff_capabilities` returns
`keyedHandoffVersion: 1`. `specialists_handoff_keyed` takes the ordinary handoff
fields plus required `parentThreadId` and `handoffKey`. It returns
`{ status: "started" | "failed" | "uncertain", threadId, error }`.
Concurrent and repeated requests share one persisted launch record. Definite
rejections can retry; uncertain spawns recover metadata and never launch a second
worker. A key belongs to one project/parent pair. Callers should pause automatic
polling on failures and offer explicit recovery. The generic `specialists_handoff`
RPC keeps its existing output and remains compatible with prior callers.

A keyed handoff with an unconfirmed spawn normally only searches for the original
worker. `relaunchUncertain: true` is reserved for explicit user-confirmed recovery:
it searches again and permits a new spawn only if no worker is found. A delayed
original request may still create a duplicate; never set it on automatic retries.
