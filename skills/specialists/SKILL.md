---
name: specialists
description: Hand work off to a specialist agent (a named preset with its own prompt and model) set up in the Specialists plugin. Use when the user @mentions a specialist, asks for one by name ("ask the reviewer to…"), or wants to list, add, or remove specialists.
---

# Specialists

A specialist is a named agent preset: a description, a standing prompt, and a
model. The user sets them up on the Specialists page in the BB sidebar and
mentions them in a message, such as "ask the @reviewer to look over the
unstaged changes".

## Handing off

A mention is a request to delegate. Do not do the mentioned work yourself.

1. Call the `specialist_handoff` tool with the specialist's name and a task
   brief. If the tool is not available in this session, use the CLI instead:

   ```
   bb specialists handoff reviewer --task "$(cat <<'EOF_TASK'
   Review the unstaged changes in this workspace (git diff). …
   EOF_TASK
   )"
   ```

2. The handoff spawns a child thread that runs the specialist's prompt on its
   model, in this thread's workspace. It sees the same files and uncommitted
   changes, but none of this conversation. Write the brief to stand alone:
   the goal, the relevant paths, exactly what to inspect, any constraints, and
   the result you want back.
3. The specialist runs on its own configured model. Only when the user
   explicitly asks for a different model, provider, or reasoning level for this
   request, pass `model`, `provider`, or `reasoningLevel` to the tool (CLI:
   `--model`, `--provider`, `--reasoning-level`). The change applies to that one
   handoff. Never change the model on your own.
   Likewise it runs on its configured machine, or this thread's when it has
   none. Only when the user names a machine for this request, pass `machine`
   (CLI: `--machine`), as an id or name from `bb machine list`. On another
   machine the specialist gets a fresh workspace and does not see this
   thread's uncommitted changes, so put what it needs in the brief.
4. Tell the user which thread took the work, as `@thread:<id>`.
5. You are notified when the child thread finishes. Read its result with
   `bb thread output <id>` and relay it.
6. For follow-up work for the same specialist, call `specialist_handoff` again
   with `thread: "<id>"` of the earlier handoff. The task goes to that thread,
   so the specialist keeps its context (devices, files, findings). Start a new
   thread only for unrelated work.

## Commands

```
bb specialists list [--json]
bb specialists show <name> [--json]
bb specialists add <name> --prompt <text> [--description <text>] [--provider <id>] [--model <id>] [--reasoning-level <level>] [--permission-mode full|auto|accept-edits] [--machine <id-or-name>]
bb specialists remove <name>
bb specialists handoff <name> --task <brief> [--provider <id>] [--model <id>] [--reasoning-level <level>] [--machine <id-or-name>]
```

- Names are lowercase letters, digits, and dashes, up to 32 characters. A
  leading `@` is ignored.
- `add` replaces an existing specialist with the same name.
- `--prompt` and `--task` may span lines. Pass multi-line text through a quoted
  heredoc, as above, so the shell does not expand backticks or `$(...)` in it.
- Omit `--provider` and `--model` to use the project's default for new threads.
- `handoff` must run inside a BB thread. It uses that thread as the parent.
- `handoff --provider/--model/--reasoning-level` override the specialist's
  saved settings for that handoff only. Omitted ones keep the saved values. A new
  `--provider` without `--model` uses that provider's default model. Model ids
  are not checked up front; an unknown one fails when the thread starts.
