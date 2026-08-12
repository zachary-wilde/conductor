# Quickstart

From a fresh install to your first Ravel in four steps: install Conductor, install
and log in to one coding-agent CLI, add a repository, and start a Ravel.

Conductor is a **Windows** desktop app. It does not ship AI credentials of its own —
it drives coding-agent CLIs you already have a subscription for, each in its own git
worktree. One CLI login is the floor; this guide uses **Claude Code** (the default
harness). Codex and omp are supported the same way — see [Other CLIs](#other-clis).

---

## 1. Install Conductor

Run the Windows installer (`Conductor Setup …exe`, produced by `npm run dist`). It is
a per-user NSIS install — no administrator elevation.

- **The installer is currently unsigned.** Windows SmartScreen will warn
  *"Windows protected your PC"* / *"Unknown publisher: Conductor"*. That is expected
  until code-signing lands. Only run an installer you built yourself or obtained from
  a source you trust; then choose **More info → Run anyway**.
- On first launch Conductor starts a background **Core** process (the part that owns
  your repositories, sessions and Ravels) and opens a window that connects to it. The
  Core is designed to keep running with the window closed, and the current build
  registers itself to start at sign-in so that happens automatically — see
  [SECURITY.md](../SECURITY.md) and note this is being made opt-in.

That's it for the app. You should land on the Command Centre.

## 2. Install and authenticate one CLI

Conductor detects three CLIs on your `PATH`: `claude`, `codex`, and `omp`. Harness
availability is shown in the app (installed / missing). You need at least one
installed **and logged in** — Conductor uses the CLI's own login; it never stores or
asks for API keys.

**Claude Code (the default harness):**

```powershell
npm install -g @anthropic-ai/claude-code   # puts the `claude` command on PATH
claude                                       # run once and complete the browser login
```

- Authenticate Claude Code with its **interactive claude.ai login** (the subscription
  you are already paying for). Conductor deliberately ignores `ANTHROPIC_API_KEY` /
  `ANTHROPIC_AUTH_TOKEN` for Claude children: a key there would silently bill a metered
  API account instead of your subscription, which is the opposite of "bring your own
  subscription." Log in interactively and leave the env vars unset.
- Verify in any shell with `claude --version` (or `claude doctor`). Then reopen
  Conductor — the Claude harness should show as **installed**.

> The npm package still works, but Anthropic now recommends its native installer
> (`irm https://claude.ai/install.ps1 | iex` on Windows). Either way, Conductor just
> needs `claude` on `PATH`. Use the vendor's current instructions if in doubt.

## 3. Add a repository

Conductor works on **local git repositories** — it does not clone for you.

1. Have a git repo on disk (e.g. `D:\code\my-app`). Make at least one commit so there
   is a base branch to branch worktrees from.
2. In Conductor, choose **Add repository** and select the repo's folder. Conductor
   confirms it is a git repository and adds it.

If you have no repositories yet, the empty state surfaces **Add repository** directly.
Worktrees Conductor creates are placed under a root you can configure (Settings →
worktree root; default `%USERPROFILE%\.conductor\worktrees`).

## 4. Start your first Ravel

A **Ravel** is a delegated job: you describe it, the orchestrator proposes a plan
(a mission plus a set of briefs), you approve that exact plan, and each brief runs in
its own worktree on its own branch. Nothing spawns until you approve.

1. From the Command Centre, start a **Ravel** against the repository you just added.
2. Describe the job in one sentence (e.g. *"add a /health endpoint to the API"*).
3. The orchestrator may **ask a clarifying question** — answer it.
4. It proposes a **plan revision** (mission + briefs). Read it and **approve**.
5. Each brief spawns as a child agent in its own worktree. Watch the fleet; when a
   child finishes, the repo's own **verify** command (if configured) runs in that
   worktree and its verdict reaches the orchestrator before the exit is acted on.
6. Review the resulting branch and **land** it (a real merge commit on the base).

That is the full loop: clarify → propose → approve → spawn → verify → review → land.

---

## What it costs

Between events the orchestrator is not running — there is no live session and no spend
while nothing is happening. Work costs whatever your CLI subscription charges for the
tokens the agents actually use. Conductor adds no per-token billing of its own.

## Other CLIs

The same steps work for the other supported harnesses. Install and log in to the one
you want, then Conductor detects it on `PATH`:

- **Codex** (OpenAI): `npm install -g @openai/codex`, then run `codex` and
  **Sign in with ChatGPT** (or set an OpenAI API key per the vendor's instructions).
  Verify with `codex --version`.
- **omp** (Z.AI / GLM and other providers): Conductor looks for an `omp` executable on
  `PATH`. Install and authenticate omp per its vendor's instructions, then verify the
  ZAI harness shows as installed in Conductor.

A few things worth knowing up front, all covered in [SECURITY.md](../SECURITY.md):

- **Agent children run at your Windows user privilege, not in a sandbox.** A git
  worktree gives each child its own checkout and branch; it does **not** confine what
  the process can read, write, or run.
- **Claude Code Ravel children launch with `--dangerously-skip-permissions`** (Claude's
  own auto-approve-everything flag). There is currently no toggle for this. Treat a
  Ravel as you would running that CLI yourself against the repository.
- **Hooks and verify are shell scripts you configure.** They run at user privilege when
  a worktree is created or a child finishes. Only configure them for repositories you
  trust.
