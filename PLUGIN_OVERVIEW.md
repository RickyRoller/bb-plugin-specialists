Set up specialist agents, each with its own prompt and model, and hand work to
them by @mentioning them in a message.

## What you get

- A **Specialists** page in the left sidebar to create, edit, and remove
  specialists. Each has a name, description, prompt, and model.
- Specialists in the composer's `@` mention menu.
- A handoff: when a message mentions a specialist, the thread spawns a child
  thread that runs the specialist on the relevant work.
- A `bb specialists` command for the same setup and handoff from a terminal.

## How it works

Write "ask the @reviewer to look over the unstaged changes". The mention tells
the thread's agent to delegate. It writes a task brief and hands it off. The
specialist's thread runs on the specialist's model, in the same workspace, so it
sees the same files and uncommitted changes. When it finishes, the original
thread is notified and relays the result.

Specialists live in this plugin's own storage on the BB server. The plugin needs
no account, API key, or external service.
