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
3. Tell the user which thread took the work, as `@thread:<id>`.
4. You are notified when the child thread finishes. Read its result with
   `bb thread output <id>` and relay it.

## Commands

```
bb specialists list [--json]
bb specialists show <name> [--json]
bb specialists add <name> --prompt <text> [--description <text>] [--provider <id>] [--model <id>] [--reasoning-level <level>]
bb specialists remove <name>
bb specialists handoff <name> --task <brief>
```

- Names are lowercase letters, digits, and dashes, up to 32 characters. A
  leading `@` is ignored.
- `add` replaces an existing specialist with the same name.
- `--prompt` and `--task` may span lines. Pass multi-line text through a quoted
  heredoc, as above, so the shell does not expand backticks or `$(...)` in it.
- Omit `--provider` and `--model` to use the project's default for new threads.
- `handoff` must run inside a BB thread. It uses that thread as the parent.
