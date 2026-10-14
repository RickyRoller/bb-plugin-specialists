# bb-plugin-specialists

Specialist agents for BB. A specialist is a named preset with a description, a
prompt, and a model. Mention one in a message and the thread hands that work to
a new thread running the specialist.

```
ask the @reviewer to look over the unstaged changes
```

## Install

```
bb plugin install ~/development/bb-plugin-specialists
```

## Set up a specialist

Open **Specialists** in the left sidebar and choose **New**, or use the CLI:

```
bb specialists add reviewer \
  --description "Reviews code changes for bugs and risky design" \
  --provider claude-code --model claude-opus-5-5 --reasoning-level high \
  --prompt "$(cat reviewer-prompt.md)"
```

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
   same files and uncommitted changes.
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
  Say so in the specialist's prompt if it should only read.
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
