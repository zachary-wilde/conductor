# Privacy

What Conductor stores locally, what it logs, and what leaves your machine. Every claim
here is grounded in the source; where a behavior is a limitation rather than a feature,
it says so. Read with [SECURITY.md](./SECURITY.md).

**Headline:** Conductor is local-first. It runs **no hosted relay, no telemetry, no
analytics, no crash reporting, and no auto-updater** that phones home. It stores **no
vendor API keys or CLI credentials** — it uses each CLI's own login. The only network
traffic Conductor itself originates is a loopback health probe to its own Core; the
only inbound traffic is the Core serving your local/LAN clients. The agent CLIs you run
talk to their own vendors under your existing subscriptions; Conductor does not proxy or
see those credentials.

---

## 1. Credentials: Conductor stores none

Conductor does not ask for, store, or transmit API keys for the coding agents. It relies
on each CLI's own authenticated login (Claude Code, Codex, omp), which lives in that
CLI's own config on your machine — for example Claude Code's `~/.claude/`.

For Claude Code specifically, Conductor goes further: it **strips** `ANTHROPIC_API_KEY`
and `ANTHROPIC_AUTH_TOKEN` from the child's environment on purpose
(`src/main/harness.ts`). A key set there would silently bill a metered API account
instead of the claude.ai subscription you are already paying for, so Conductor removes
it and logs only the *name* of the variable it removed — never the value.

The only secret Conductor itself mints is the **web access token** for the remote
operations API (below).

## 2. Local data

Conductor keeps everything under a versioned data directory:

```
%APPDATA%\conductor\conductor-data\v2\
```

(`src/core/data-dir.ts`. The legacy `conductor-data\store.json` is imported once and left
in place as a migration source.) A single-instance lock (`core.lock`) guarantees one Core
writes here at a time. Typical contents:

| Path | What it holds |
| --- | --- |
| `store.json` | Repositories (local folder **paths** — no remote secrets), **Settings**, worktrees, Ravels, Roundtables, insight state. Ravel records include the mission, conversation messages, plan/briefs, and each child's published report and verification result. |
| `automations.json` | Automation definitions (cron schedules / heartbeats) and their occurrence ledger. |
| `events\` | The unified operations **timeline** as a bounded, rotating journal of segment files (~10,000 events retained; oldest dropped whole). Contains normalized summaries of agent activity, file-activity (file paths), review decisions, etc. |
| `core-endpoint.json` | The Core's health/control ports and pid. **No token.** |
| `web-endpoint.json` | The operations API host/port/scheme. The access token is written here **redacted** (`<redacted>`). |
| `tls\` | Only when TLS is opted in (`CONDUCTOR_WEB_TLS=1`): the self-signed certificate and **private key**. |
| `scheduler.json` | The scheduler's `lastCheckedAt` (catch-up bound across restarts). |

**Settings** (`src/shared/types.ts`) contains preferences only — default harness, theme,
hook/verify **scripts**, the worktree root, the per-Ravel token ceiling (a numeric
budget, not a credential), editor and canvas-layout preferences. There are **no** API
key, password, OAuth, or refresh-token fields anywhere in Settings or the store
(`src/main/store.ts`).

Worktrees Conductor creates live under a root you can configure (Settings → worktree
root; default `%USERPROFILE%\.conductor\worktrees`). The repository contents an agent
edits are in your repository and its worktrees, not in Conductor's data dir.

### Secrets on disk — a limitation

These files are written with **default OS file permissions**; Conductor does not set
restrictive permissions (no `0600`/ACL) on them today:

- the optional TLS **private key** (`tls\key.pem`);
- the per-Ravel `capSecret` — a random value generated per Ravel, stored in `store.json`,
  and **projected out of every IPC/preload boundary** so clients never receive it. It is
  an internal identifier, not a user credential.

The web access token itself is held in memory while the Core runs and written to
`web-endpoint.json` only in redacted form (it is shown in the in-app Remote-access panel
and the `C1:` pairing code, which you control).

## 3. Logs

- The Core writes operational lines to its **stdout** (e.g. the port it bound, and that a
  token is set — the token itself is **redacted** in the log). By default a detached Core
  discards stdout; set `CONDUCTOR_CORE_LOG=<file>` to redirect it to a file for diagnosis
  (`src/main/core-client.ts`).
- Conductor does **not** log conversation content, brief bodies, repository file contents,
  or agent terminal output to any log file. Terminal (PTY) output is streamed live to the
  window and held in memory for usage estimation; it is not persisted to disk by
  Conductor.
- When a conflicting auth env var is stripped from a Claude child (§1), the log records
  the variable **name** only.

## 4. What leaves your machine

**Nothing Conductor-originated.** A search of the source confirms every network call
Conductor makes on its own is to `127.0.0.1` (a health probe to its own Core); the Core's
only other network role is **inbound**, serving your local window and — only when you opt
in — your LAN devices. There is no telemetry, analytics, Sentry/crash-reporting, or
auto-updater dependency, and `electron-updater` is not wired.

Two things do cross the network, but neither is Conductor shipping your data to a
Conductor server:

1. **The coding-agent CLIs talk to their own vendors.** When a Ravel runs, Conductor
   hands the prompt to the CLI (on stdin for `claude`/`codex`, on argv for `omp`) and
   captures its stdout/stderr locally. The CLI then communicates with Anthropic / OpenAI /
   Z.AI under **your** subscription and **that vendor's** privacy policy. Your prompts and
   repository contents an agent reads are sent to the vendor exactly as if you ran that
   CLI yourself — Conductor does not add a relay and does not see the vendor credentials.
   Review each vendor's policy to understand what they retain.
2. **Remote/LAN access is yours to enable.** When you turn on LAN access, the operations
   API and the live timeline — including agent-activity summaries, repository file paths,
   and branch diffs you open in review — become reachable on your LAN to any device that
   presents the access token (see [SECURITY.md §6](./SECURITY.md)). This traffic stays on
   your LAN unless you route it through a VPN; it is **cleartext unless you opt into TLS**.

## 5. Removing the data

To start fresh, stop Conductor and delete the data directory above (worktrees live in
their own root). The Core refuses to overwrite a store it cannot parse, so a corrupt
`store.json` is preserved rather than silently erased; an in-app reset/export/import on
the load-error screen is a pending release item.
