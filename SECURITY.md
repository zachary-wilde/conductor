# Security model

Conductor is a Windows desktop app that drives coding-agent CLIs (`claude`, `codex`,
`omp`) as child processes in git worktrees, orchestrated by a standalone background
**Core** process. This document describes what actually runs, at what privilege, and
what the network boundary does and does not protect. It does not overclaim: where a
protection is missing or pending, it says so.

Read with [PRIVACY.md](./PRIVACY.md) (what is stored and what leaves the machine) and
[docs/quickstart.md](./docs/quickstart.md).

---

## Threat model in one paragraph

Conductor assumes **the Windows user account and the local machine are trusted**. It
launches agent CLIs and your own shell scripts **at your full user privilege**, and it
trusts the loopback boundary for its local control channel. It is *not* a sandbox, and
it is *not* safe to point at untrusted repositories or expose to untrusted networks
without understanding the sections below.

## 1. Agent execution runs at your privilege, not in a sandbox

A Ravel child is a normal process spawned under your Windows user account. Conductor
gives each child its **own git worktree** on its own branch (`git worktree add`) so
sibling agents don't trip over each other's files. That is the *only* isolation.

A worktree is **not** an OS sandbox:

- There is **no job object, no restricted token, no AppContainer, and no filesystem
  ACL** around a child. (`src/main/git.ts` createWorktree; `src/main/sessions.ts`
  spawnPty → `node-pty` spawn with `useConpty`.)
- A child process can **read and write any file your user can, run arbitrary shell, and
  reach the network** — including files outside its worktree.
- Hooks and the verify command (below) inherit the same privilege.

Treat a running Ravel the way you would treat running that CLI yourself against the
repository.

## 2. Auto-approve: Claude Code children skip their own permission prompts

When a Ravel dispatches a **Claude Code** child, Conductor launches it with
`--dangerously-skip-permissions` — Claude Code's own flag that auto-approves **every**
tool call the agent makes (file edits, shell, etc.) at your privilege. This is
hardcoded for Ravel children today; there is no per-Ravel or global toggle that turns
it off. (`src/main/harness.ts` buildLaunchArgs; `src/main/ravel.ts` createChildSession
passes `autoApprove: true`.)

What this is **not**:

- It does **not** apply to the headless **orchestrator/manager** turns — those run in
  print mode (`claude -p`, `codex exec --sandbox read-only`, `omp -p`) and do not carry
  the auto-approve flag. A manager only plans and delegates.
- Codex and omp children do **not** receive an equivalent auto-approve flag from
  Conductor; they run with whatever their own defaults are.
- It is **not** Conductor approving anything — it is telling the CLI not to ask *you*.

**Implication:** until an off-by-default toggle ships, assume a Claude Ravel child can
do anything your user can, without per-action confirmation. Only run Ravels against
repositories (and on machines) where that is acceptable. This is tracked as a release
item: make auto-approve an explicit, off-by-default opt-in surfaced at Ravel creation.

## 3. Hooks and verify run arbitrary shell

Two operator-configured shell scripts run automatically, at user privilege, with no
per-run consent gate (`src/main/hooks.ts` runHook; `src/core/backend.ts` worktree:create
fires the hook; `src/main/ravel.ts` runVerification runs verify on child exit):

- **Hooks** — a global script and/or a per-repository script, run when a worktree is
  created. They receive `WORKTREE_PATH`, `REPO_PATH`, `BRANCH` in the environment.
- **Verify** — the repo's own verify command, run in a finished child's worktree so the
  orchestrator learns whether the change actually holds up rather than only trusting the
  child's claim.

These run via Git-Bash `bash -c <script>` if bash is available, otherwise a temporary
`.cmd` run through `cmd.exe /d /c`. They are exactly as powerful as any script you would
run yourself. **Only configure hooks/verify for repositories you trust**, and read what
they do before enabling them. A first-run consent gate before arbitrary-shell execution
is a pending release item.

## 4. `allowRisky` is currently a no-op

The Ravel configuration exposes an `allowRisky` flag (persisted and shown in the UI).
As of this build it **gates nothing**: it is read into the config and projected back,
but no code path consults it to permit or deny an operation. Do not rely on it as a
safety control. The release plan is to either wire it to actually gate risky operations
or remove the field entirely.

## 5. Local network: two surfaces, two postures

The Core exposes two local network surfaces with different security postures.

### 5a. Remote operations API (web + SSE) — token-gated

This is the HTTP + Server-Sent-Events API the web/Android operator and any browser
client use (`src/main/operations/web-server.ts`). Current behavior:

- **Bind:** loopback (`127.0.0.1`) by default. LAN exposure is opt-in via
  `CONDUCTOR_WEB_HOST=0.0.0.0`.
- **Authentication:** when a token is configured (always, when bound beyond
  loopback; auto-generated on Core start or set via `CONDUCTOR_WEB_TOKEN`), every
  `/api/*` call requires a **bearer token** sent as `Authorization: Bearer <token>`,
  compared with a constant-time (`timingSafeEqual`) check. The token is **never**
  read from a URL. A tokenless loopback dev server does not gate on a bearer, but
  its `/api/*` surface is restricted to **same-origin** requests (see CORS below),
  so a drive-by web page cannot reach it.
- **Live stream:** because `EventSource` cannot send an `Authorization` header, the SSE
  stream is opened with a **short-lived, single-use ticket** (POST `/api/sse-ticket`
  with the bearer, then connect with `?ticket=`). The bearer therefore never appears in
  a URL or stream parameter; a captured ticket is worthless after first use or ~30 s.
- **Other defenses:** a DNS-rebinding `Host` guard (IP/`localhost` only — use the LAN IP,
  not a hostname), a per-IP fixed-window rate limit (300 requests / 60 s), and a 1 MB
  request-body cap.
- **CORS:** a **token-authenticated** response carries `Access-Control-Allow-Origin: *`
  — safe because every state-changing call requires the bearer, so a cross-origin
  page without the token is refused. A **tokenless** (loopback dev) response never
  emits `*`: `/api/*` requires a matching `Origin` (or none, for local tooling), and
  a cross-origin request or preflight is refused with `403`.

### 5b. Local control channel — per-boot authenticated

The Core's control channel is a raw TCP socket on **loopback only** that the Electron
window drives (`src/core/control-server.ts`, `src/core/main.ts`). Each Core boot
generates a fresh random secret, writes it to `core-endpoint.json`, and requires that
secret in the first frame before dispatching any backend method. The endpoint hint is
written with best-effort owner-only permissions (`0600`); on Windows it remains under
the per-user data directory because `chmod` cannot express a complete ACL.

The `system:readFile` / `system:writeFile` handlers accept only paths inside the Core
data directory, a repository path known to the store, or a tracked worktree. They
reject traversal and symlink escapes with an error rather than silently succeeding.

## 6. Remote / LAN access

When you opt into LAN access (`CONDUCTOR_WEB_HOST=0.0.0.0`, or Settings → Remote
access) the operations API and the live timeline become reachable from other devices on
your network. See `docs/on-device-remote-verification.md` for the pairing procedure.

- **TLS:** loopback remains plaintext by default. Any non-loopback bind enables
  HTTPS by default; the Core generates a self-signed certificate once, persists it,
  and puts its SHA-256 fingerprint into the `C1:` pairing code. Setting
  `CONDUCTOR_WEB_TLS=1` also enables TLS explicitly.
- **Explicit opt-out:** `CONDUCTOR_WEB_TLS=0` on a non-loopback bind serves the API over
  **cleartext** with a loud startup warning. The bearer token still gates every request, but
  traffic is unencrypted — only use it on a trusted LAN (e.g. for the Android WebView client,
  which cannot trust a self-signed certificate). Prefer TLS; bind to loopback when you can.
- **Native certificate pinning is not built.** The fingerprint is available for an
  operator to verify by eye, but the native mobile pinning layer is a deferred track.
- The web/Android client treats the bearer token as the secret and persists it locally
  on the device.

## 7. Safe operating guidance

- **Machine and account are trusted.** Don't run Conductor as an administrator or on a
  shared/kiosk machine.
- **Only add repositories you trust**, and especially only configure hooks/verify for
  repositories you trust — they run as you.
- **Default to loopback.** Leave the web API on `127.0.0.1` unless you need LAN access.
- **LAN transport:** non-loopback binds are HTTPS by default; verify the fingerprint
  in the `C1:` pairing code and treat the access token as a password. Use a trusted
  network.
- **Mind the auto-approve flag** on Claude Ravel children (§2). If your workflow or
  policy cannot tolerate auto-approved full-privilege agents, do not run Claude Ravels
  against sensitive repositories yet.
- **Keep the Core endpoint files private.** `core-endpoint.json` and `web-endpoint.json`
  live under your user data dir; don't share that directory.

## 8. Known limitations & hardening in progress

This is an honest list of what is **not** yet a protection, drawn from the current
source. Items are tracked in the release plan:

- **Auto-approve is hardcoded on** for Claude Ravel children (§2); no toggle yet.
- **`allowRisky` gates nothing** (§4).
- **No update mechanism** is wired yet; installed copies do not auto-update.
