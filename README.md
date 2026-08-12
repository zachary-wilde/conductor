# Conductor

**You choose which specific model does which specific job, and then you just talk.**

A roster of named models — an orchestrator, a lead engineer, an auditor, a minor-task hand —
addressed in plain language, each told only what its own role requires. You assign the harness and
the model per role, you describe what you want in a sentence, and the orchestrator turns that into
briefs and hands each one to the agent you nominated for it.

Conductor is a Windows desktop app that drives Claude Code, Codex and omp as child processes, each
in its own git worktree. Its static fallback catalogue contains 25 model names across those three
harnesses: Anthropic aliases and pinned ids for Claude Code, the `gpt-5.x` line for Codex, and —
through omp's fully-qualified `provider/model` catalogue — Zhipu GLM, Anthropic, OpenAI and Google
Gemini. An installed CLI's live catalogue replaces its fallback, so the number actually selectable
varies. Assigning across vendors is the point: Opus can audit what GLM wrote. The orchestrator seat
is chosen the same way as every other role, so when one vendor runs dry you re-point the next
Ravel at another. Re-pointing a Ravel that is already running is not implemented yet — see
[Honest status](#honest-status).

It runs on the CLI logins you already have — no API keys and no separate API metering or
per-token billing from Conductor. One subscription is the floor. More makes it better and is
never required.

> **Status:** covered by 1,075 deterministic tests that spend zero AI quota; a 57-check GUI smoke drives
> the built Electron app through its normal workflow against a dummy harness; and a 7-check survival smoke
> proves work keeps running with the window closed. Orchestration now lives in a standalone background
> Core with a remote web/Android operator (timeline, controls, automations, review + diff). No paid
> harness has done real work yet, and the remote operator has not run on a physical phone. See
> [Honest status](#honest-status).

## Security & execution model

See [SECURITY.md](SECURITY.md) and [PRIVACY.md](PRIVACY.md) before running agents. Agents run at
your full user privilege; a git worktree is isolation for changes, **not a sandbox**. Claude
auto-approve (`--dangerously-skip-permissions`) is opt-in per Ravel and defaults off; hooks and
verify commands run arbitrary shell only after one-time consent.

## Why it exists

Today you get one of two things. A single model does everything: it drifts, over-builds, invents
requirements nobody asked for, and edits files it had no business touching. Or you get variety by
writing code — a framework, a config, a graph of agents — and now you maintain a system instead of
using one.

Conductor is the third option: *these models, doing these jobs, because I said so.* Picked the way
you would pick people. The product follows these rules:

**Nobody freelances.** Scope is enforced, not requested, and the boundary runs both ways, asserted
by tests:

- a child receives its own brief and nothing else — no mission, no conversation, no sibling briefs
- a dependent brief receives only the report its dependency chose to publish, never that
  sibling's terminal output
- the manager sees brief ids, titles, roles and dispatch status — never brief bodies. It does see
  the closing output of a child that published no report, because something truthful about a
  finished child beats "completed without a report"; that text goes to the manager alone and is
  labelled as terminal output, never passed on to another agent

The reason is focus. An agent that cannot see work outside its role cannot wander into it, and an
agent with less to be confused by invents less. Smaller prompts do use less quota, but that is a
side effect rather than the argument. It is not a sandbox either: a child can still read its own
worktree.

**Any model can hold any position, orchestrator included.** Nothing in the code assumes a vendor.
Cheap models are not lesser models — they are differently good, and refusing one because it is
inexpensive throws away capability. Usage limits are per-vendor, so when one runs dry you re-point
the roster rather than stop.

**Effort scales with the request.** Fan-out is a cost, not a goal: four roles get involved when
there is genuinely four roles' worth of work, never to look thorough. The manager proposes a plan
revision — a mission plus a set of briefs — and nothing spawns until you approve that exact
revision. A stale or unapproved revision is refused in code, not by convention.

**Idle costs nothing.** The manager is not a live session. A message, plan approval, or child exit
starts a headless event cycle with at most three sequential invocations. The common case uses one;
another runs only so the manager can act on a status it requested or correct a failed tool call.
Between events there is no process and no spend. A test advances six simulated hours and asserts
zero timers and zero invocations, and a second asserts the file-activity watcher holds no interval
until a session is actually live.

**Deciding is a different job from doing.** A Ravel delegates; a *roundtable* deliberates. Seat two
or three named models — ideally from different vendors — at one question about the repository as it
actually stands, and they answer each other in strict rotation until they converge or run out of
turns. Nobody gets a worktree and nothing is edited. The output is a written strategy, and one
button hands it to a Ravel as its opening instruction. It is bounded before it starts: a turn cap,
and the same estimated-token ceiling that stops a runaway fleet.

**The operator can work beside the agents.** Open an ordinary terminal for direct repository work,
or claim an unstarted Ravel brief and complete it as a human seat. A claimed brief gets the same
isolated worktree, branch, request channel, report path and independent verification as an AI child;
it is not a second workflow with weaker evidence.

**The workspace belongs to the operator.** Every working view is a movable, resizable Canvas panel
that stays inside the viewport. The View menu can hide or restore open panels without deleting their
work, named layouts persist across restarts, and one action resets the workspace to the Command
Centre for launching Ravels, Roundtables and terminals.

**Advice earns the interruption.** The corner mascot is driven by deterministic rules over durable
application state, not by another model or a timer. After real activity it may surface one ranked,
deduplicated observation about scope, coordination, verification, progress or cost; otherwise it
stays silent.

**Work continues with the window closed.** Orchestration does not live in the window. A standalone
background Core process — the sole owner of the store, sessions, Ravels, Roundtables, automations and
the operations layer — keeps running when Electron quits; the window is a thin client that connects to
it, or spawns it and lets go. Reopen and it reconnects to the same Core, active sessions and all. A
7-check survival smoke proves it.

**Watch and steer from anywhere on your LAN.** Every agent action across Ravels, Roundtables and
ordinary sessions folds into one normalized, replayable timeline. A responsive web operator — the same
app wrapped as a signed Android build — pairs to the Core with a scanned code and gives you the live
timeline, capability-gated worker controls, automations, and branch review with a bounded diff, over
your own LAN. No hosted relay, no API keys: a bearer token, a single-use stream ticket, and opt-in TLS.

## How a run works

```
you             manager (headless, at most 3/event)     children (pty, per worktree)
 |                              |                                    |
 |-- "fix auth refresh" ------->|                                    |
 |<-- ask_clarification --------|                                    |
 |-- answer ------------------->|                                    |
 |<-- propose_plan (rev 1) -----|                                    |
 |-- approve ------------------>|                                    |
 |                              |-- spawn_child(brief-1) ----------->| worktree + branch
 |                              |                                    | ... works ...
 |                              |<-- child exits --------------------|
 |<-- complete -----------------|                                    |
```

Each arrow into the manager starts one bounded event cycle of at most three invocations. There is
no manager between event cycles.

## Design notes

**Context budget.** Every manager prompt is rebuilt from durable state and hard-capped at 12,000
characters — the plan digest, a one-line-per-child fleet snapshot, the last 12 conversation
messages, and the event directive. Over the cap it *throws*, rather than silently truncating, because
quiet truncation is how a cheap manager grows back into an expensive one. A typical turn is ~3,600
characters.

Three things always ride along, because a stateless manager forgets otherwise: the ratified mission
constraints, the messages the plan was built from (pinned regardless of age), and each brief's
`dependsOn` edges.

**Prompt delivery is per harness, and the difference is load-bearing.** `claude` and `codex` install
as npm `.cmd` shims, so they launch through `cmd.exe /d /c`, which cannot carry a newline inside an
argument — their prompt goes on stdin (`claude -p`, `codex exec -`). `omp` is a real `.exe` that
ignores stdin in print mode, so its prompt rides on argv. All three verified against the installed
CLIs, not assumed.

**Process trees.** Harnesses launch as `cmd.exe /d /c <shim>`, so killing the direct child reaps
only `cmd.exe` and orphans the CLI — which then keeps burning quota after the app closes. Every exit
path uses `taskkill /T /F`.

## Testing without spending money

Testing an AI orchestrator is mostly a cost problem. Conductor solves it two ways:

- **Fakes at a service seam.** Every process-touching dependency — sessions, git, store, harness
  invocation — is injected, so the full clarify → propose → approve → dispatch flow runs in
  milliseconds with no processes and no models.
- **A dummy harness.** `scripts/ravel-dummy-harness.mjs` stands in for every CLI and emits scripted
  tool calls, so the real spawn path, real stdin delivery and real stdout parsing are exercised for
  free. `scripts/verify-smoke-log.mjs` then judges the resulting log — including that the manager
  prompt never carried a brief body and the child prompt never carried the mission.

```bash
npm run typecheck
npm test          # 1,075 tests, no AI spend
npm run build && npm run smoke:gui   # 57 checks against the real Electron app (driven through the Core)
npm run smoke:core                   # 7 checks: work survives the window closing, then reconnects
```

## Honest status

What is proven:

- orchestration semantics, via 1,075 deterministic tests including idle-cost, context-boundary,
  independent-verification, human-seat, terminal-session, operations-timeline and Canvas-window coverage
- the headless transport, via a real spawned process with a multi-line prompt over stdin
- the full loop through the real Electron app: clarify → answer → propose → approve → spawn →
  steer → child exit → verify → review → land, driving the built app under Electron against the dummy
  harness. The child is dispatched into a real git worktree on its own branch and commits a real
  file there, so landing produces an actual merge commit on the base — the run asserts the commit
  id, not just that something was reported. `verify-smoke-log.mjs` gates the same run at 11/11,
  including that the manager prompt never carried a brief body and the child prompt never carried
  the mission.
- the roundtable loop: two seats on different harnesses argue one question in strict rotation,
  converge on a written strategy, and have it persisted — driven through the real app against the
  dummy harness, asserting the alternation, the per-seat billing, that the second seat's prompt
  carried what the first actually said, and that the operator can read it afterwards
- independent verification: the repo's own verify command runs in the finished child's worktree,
  its verdict reaches the orchestrator before that exit is acted on, and a fleet cannot be declared
  complete while any verdict is still outstanding — so a child's claim about itself is never the
  only evidence in the loop
- tool-protocol compliance and plan validation, via two live-model probes — which caught a real
  defect: the prompt named the tools but never the plan schema, so a real proposal failed validation
  eleven ways
- store durability: settings, repositories, worktrees and ravels survive a close/reopen cycle, and
  a store that cannot be parsed is never overwritten
- the operator workspace: ordinary terminals, human-claimed Ravel briefs, saved Canvas layouts,
  viewport-safe window controls and Command Centre launchers are covered by deterministic tests;
  the built-app smoke also exercises live Canvas movement, hiding and restoration
- the insight engine: deterministic rules, ranking, deduplication, cooldowns, persistence and
  failure isolation are covered without invoking a model; evaluations run only after real events,
  never from a background timer
- the standalone background Core: the whole backend (store, sessions, Ravels, Roundtables, automation
  and the operations/remote layer) runs in a detached user-level process that Electron connects to or
  spawns. Closing the window leaves active sessions, timers and evidence running in the Core, and a
  relaunched window reconnects to the same Core rather than starting a second. Proven by
  `npm run smoke:core` (7/7) against a real spawned Core, and the full 57-check GUI smoke now drives the
  built app end to end THROUGH the Core over its loopback control channel.
- a unified operations timeline: Ravel-manager turns, Ravel children, Roundtable seats, ordinary
  sessions and file activity are projected into one normalized, cursor-ordered event journal that
  replays over IPC and SSE; direct worker controls (message / pause / resume / stop / retry / archive /
  detach) are capability-gated, and `detach` promotes a live child to a standalone session, marks its
  dispatch terminal, and asks the manager to replan — naming the dependent briefs it blocks.
- automations: cron schedules and heartbeats fire off a next-occurrence timer with an occurrence ledger
  (claim-before-spawn, one catch-up after downtime, single-flight overlap coalescing); an operator
  approves an exact revision and an agent may only propose one.
- remote review + a bounded diff: `review.list` surfaces reviewable branches and `review.diff` returns a
  per-file unified diff with explicit binary / oversized / truncated / renamed states and a per-review
  byte budget; landing rechecks base/head/digest/verification/cleanliness immediately before the merge.
- the remote operator over loopback + LAN: a responsive web client the Core serves same-origin and a
  signed Android APK, paired by a QR / `C1:` code, guarded by a bearer token (header only), a
  single-use SSE ticket (no token in the stream URL), CORS, a per-IP rate limit and a DNS-rebinding
  guard — with opt-in HTTPS whose cert fingerprint rides in the pairing code.
- vendor fallback for a stalled manager: when a Ravel manager's harness runs dry mid-run — quota, rate
  limit, auth failure, or an uninstalled CLI, classified from the failure text — it re-points to the
  next installed vendor in a configurable order and continues instead of failing the turn. The switch
  is sticky and clears the model so the new vendor uses its own default. Unit- and integration-tested,
  and a genuine task failure or a timeout is deliberately NOT re-pointed.

What is not:

- a real paid harness (Claude/Codex/omp) completing real work in a worktree — every end-to-end run
  so far used the dummy harness, which spends nothing
- any comparison of token cost against other orchestrators
- a **code-signed** installer, and autostart **proven across a real sign-in**. `npm run dist` builds
  an NSIS installer (per-user, no admin) whose packaged app boots the detached Core from inside the
  asar (verified: it serves `/health` and node-pty/koffi load from `asar.unpacked`), and on normal
  launch it registers itself (`"<exe>" --background`) in the per-user Run key via the tested
  `src/core/startup-registration.ts`. What is unproven: the installer is **unsigned** (SmartScreen
  will warn), and the OS actually relaunching at sign-in is only verifiable by a real install + reboot.
- AUTOMATIC vendor fallback for a running CHILD. Only the cheap headless manager re-points on a dry
  vendor; a child that fails is reported, not silently retried on another harness (its worktree may be
  half-changed). Dry-detection is also a stderr/exit-text heuristic, not a structured provider signal.
- the remote operator on REAL phone hardware: the web client, device pairing, worker controls, review +
  bounded diff, and automations are exercised over loopback and a desktop browser (and a spoofed-Host
  test), and a signed APK is built — but never yet driven from an actual Android device on a LAN.
  `npm run remote-access` + `docs/on-device-remote-verification.md` make that run turnkey.
- native TLS certificate PINNING. The Core can serve opt-in HTTPS (`CONDUCTOR_WEB_TLS=1`) with a
  self-signed cert whose fingerprint rides in the pairing code, but the native Capacitor plugin that
  pins to it is not built, so plaintext-over-LAN + bearer token stays the recommended path for now.

Known gaps, deliberately open:

- One event permits at most three manager turns. The extra turns let the manager receive a requested
  status or correct a failed tool call; if a harness's print mode truncates multi-call replies,
  revisit `MAX_TURNS_PER_EVENT` semantics rather than reintroducing a pulse.
- `RavelConfig.managerSessionId` is always null but stays in the persisted schema. Removing it
  means a schema migration, and churning saved state to delete a dead field is a poor trade.
  (`Session`'s unreachable `ravel-manager` kind has been removed — it was not persisted.)
- Native acrylic reports `blur-behind` (the call returns success with the correct HWND), but
  whether DWM actually composites blur on this Win10 build is unconfirmed by eye.
- The Core now owns a VERSIONED data dir (`conductor-data/v2`) behind a single-instance lock, and
  imports the legacy `conductor-data/store.json` once (leaving the original as a migration source), so
  an older in-process build can no longer rewrite the new store in its shape. A second Core on the same
  dir is refused the lock and exits rather than becoming a second writer.

## Prior art

The space is crowded and most of it is Unix-shaped: Composio's Agent Orchestrator, `mux`, `jean`,
`parallel-code`, and Conductor.build (Mac, unrelated to this project — a rename is pending). Nearly
all of them are "dispatch N agents, review the diffs, merge the wins," and every one is
single-vendor: the agents are whatever the tool's provider ships.

Conductor's difference is that you name the model for each role and those names can come from
different vendors — that, the enforced context boundary that keeps each one on its own job, and a
manager that costs nothing when nothing is happening. Parallelism is a consequence, not the
category.

## Stack

Electron 31, React 18, TypeScript 5.6, Vitest, node-pty, zustand, Tailwind. Windows-only by design:
ConPTY, `taskkill`, and DWM acrylic are load-bearing. The background **Conductor Core** is a plain
Node process (Electron's own binary in Node mode) that owns orchestration and outlives the window; it
serves a loopback control channel to Electron and an HTTP+SSE operations API to remote clients. The
**remote operator** is a second React app (`src/web`) served same-origin by the Core and wrapped as a
signed Android app with Capacitor; pairing QR codes use `qrcode`, and opt-in LAN TLS uses a
`selfsigned` core-generated certificate.
