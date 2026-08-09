// ASSEMBLY of the Operations Core: the one place that wires the pure operations
// modules (journal, live feed, automation store, api adapter, transport) onto
// the REAL Electron-main singletons (store, ravel runtime, sessions, git).
//
// Everything below this module is pure/injected and unit-tested; everything
// above it (index.ts) only constructs this once and forwards its existing
// activity emissions into `observe*`. This module therefore owns the two things
// the pure layers cannot: the concrete `CoreDeps` implementation (worker detail,
// worker controls, review/land) and the loopback web server's lifecycle.
//
// Design decisions of record:
// - The web server runs BESIDE the existing IPC (dual-run). Nothing here removes
//   or replaces an IPC channel; the renderer keeps talking over IPC while a
//   remote browser talks over exactly the same api-contract via HTTP+SSE.
// - The live feed is fed from the app's OWN activity stream. `ravel:log`
//   (RavelLogEntry) is the ravel's per-entry operator activity — the faithful
//   source for ravel/manager/child timeline events; roundtable turns and NORMAL
//   session lifecycle are the other two sources. Ravel-child session lifecycle
//   is intentionally NOT double-counted from the session layer, because the
//   ravel log already records child spawn/exit.
// - `applyReviewDecision` adds the commit/digest/verification/confirmed rechecks
//   the api-contract promises for `land`; `git.mergeBranch` only rechecks branch
//   existence, tracked-tree cleanliness and conflicts, so those extra guards are
//   this adapter's job. The base is the repo's current branch, and landing is
//   refused unless it still points at the reviewed `baseCommit` (stale-base
//   guard) — the honest analogue of "the base you reviewed against".
// - Worker `archive`/`detach` map onto ravel.ts primitives: `archiveDispatch`
//   hides a terminal dispatch from the fleet, `detachChild` interrupts a live
//   child and hands its worktree to the operator. Both throw a truthful error
//   (e.g. still-live archive, unknown worker) rather than silently no-opping.

import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { isIP } from 'node:net'
import { randomUUID } from 'node:crypto'

import type {
  CreateRavelRequest,
  HarnessId,
  MergeBranchResult,
  MergeOptions,
  PublicRavelConfig,
  RavelActionResult,
  RavelDispatchRecord,
  RavelLogEntry,
  Repo,
  RoundtableConfig,
  Session,
  SessionActivityEntry,
  SessionStatus,
  Settings
} from '@shared/types'
import { createSchedulerRuntime } from './scheduler-runtime'
import type { SchedulerRuntime } from './scheduler-runtime'
import type { EpochMs } from './types'
import type { ReviewFileMeta } from '../git'

import type { ClientCommand, CommandResult, ReviewFileDiff, ReviewListItem } from './api-contract'
import { createAutomationStore } from './automation-store'
import { createCoreServices } from './core-services'
import type { CoreDeps } from './core-services'
import { createEventJournal } from './event-journal'
import { normalizeFileActivity, normalizeRavelLog, normalizeRoundtableTurn, normalizeSessionExit, normalizeSessionStatus } from './event-normalizer'
import type { NormalizedEvent, UnsequencedEvent } from './events'
import { createLiveFeed } from './live-feed'
import { reviewDiffDigest } from './review-digest'
import { loadOrCreateTls } from './tls'
import { createWebServer } from './web-server'
import type { CoreServices } from './web-server'
import type { WorkerControlState } from './worker-controls'

/** The core's own version reported in the handshake; the store schema it speaks. */
const STORE_SCHEMA_VERSION = 2
/** Informational capability tags surfaced by the handshake. */
const CAPABILITIES = ['timeline', 'events', 'worker.control', 'automation', 'review.decide', 'review.diff']
/** How many recent timeline events `worker.detail` returns per worker. */
const WORKER_DETAIL_EVENTS = 30
/** How large a window `worker.detail` scans back through the journal to find them. */
const WORKER_DETAIL_SCAN = 500
/** Per-file unified-diff byte ceiling; a larger file's patch is identified `oversized`, not decoded. */
const MAX_FILE_DIFF_BYTES = 100_000
/** Per-review cumulative patch-byte budget; once spent, later files are `truncated` (metadata only). */
const MAX_REVIEW_DIFF_BYTES = 400_000

/** The review decision command payload (the only shape `applyReviewDecision` receives). */
type ReviewDecisionPayload = Extract<ClientCommand, { name: 'review.decide' }>['payload']

/**
 * Everything the assembly needs from the real app, injected so the assembly is
 * unit-testable with fakes. index.ts supplies the concrete module singletons.
 */
export interface OperationsCoreDeps {
  /** Base directory for the journal + automation store (e.g. userData/conductor-data). */
  dataDir: string
  /** Version string reported in the handshake (e.g. the Electron app version). */
  coreVersion: string
  /** Loopback port to bind; 0 = ephemeral. */
  webPort: number
  /** Loopback host; defaults to 127.0.0.1 inside the web server. */
  webHost?: string
  /** Directory of the built static web client to serve same-origin with the API. */
  webStaticDir?: string
  /** Bearer token required on `/api/*`; unset = same-origin-only loopback access. */
  webToken?: string
  /** TLS override; non-loopback binds default to TLS. An explicit false opts out to cleartext (warned). */
  webTls?: boolean
  /**
   * Optional automation scheduler wiring. When present, scheduled/heartbeat
   * automations actually fire: the runtime spawns a Ravel or wakes a target at
   * each due occurrence. Omit it (e.g. in tests) to leave automations inert.
   */
  scheduler?: {
    defaultHarness: HarnessId
    createRavel(request: CreateRavelRequest): Promise<{ ravelId: string | null; error?: string }>
    wakeTarget(targetId: string, prompt: string): Promise<{ error?: string }>
  }

  getRepos(): Repo[]
  getSettings(): Settings
  listRavel(): PublicRavelConfig[]
  getRavel(id: string): PublicRavelConfig | undefined
  getSession(id: string): Session | undefined

  ravel: {
    steerChild(id: string, sessionId: string, note: string, settings: Settings): Promise<RavelActionResult | undefined>
    pauseRavel(id: string): PublicRavelConfig | undefined
    resumeRavel(id: string, settings: Settings): Promise<PublicRavelConfig | undefined>
    resumeInterruptedBrief(
      id: string,
      planRevision: number,
      briefId: string,
      settings: Settings
    ): Promise<RavelActionResult | undefined>
    archiveDispatch(id: string, sessionId: string): PublicRavelConfig | undefined
    detachChild(id: string, sessionId: string, settings: Settings): Promise<PublicRavelConfig | undefined>
  }
  killSession(id: string): boolean
  writeToSession(id: string, data: string): boolean

  git: {
    currentBranch(repoPath: string): Promise<string>
    resolveCommit(repoPath: string, revision?: string): Promise<string>
    changedFiles(repoPath: string, branch: string, baseBranch: string): Promise<string[]>
    mergeBranch(
      repoPath: string,
      branch: string,
      baseBranch: string,
      options?: MergeOptions
    ): Promise<MergeBranchResult>
    reviewFileList(repoPath: string, branch: string, baseBranch: string): Promise<ReviewFileMeta[]>
    fileUnifiedDiff(
      repoPath: string,
      branch: string,
      baseBranch: string,
      path: string,
      oldPath: string | null
    ): Promise<string>
  }
}

/** Pairing details a phone uses to connect: the LAN URL, the token, and a scannable code. */
export interface PairingInfo {
  url: string | null
  token: string | null
  code: string | null
}

/** A constructed Operations Core: its api adapter, the transport, and the app-side hooks. */
export interface OperationsCore {
  readonly deps: CoreDeps
  readonly services: CoreServices
  /** Bind the web server; resolves the actually bound loopback port and publishes it. */
  start(): Promise<number>
  /** Stop the web server. */
  stop(): Promise<void>
  /** The bound port once started, else null. */
  port(): number | null
  /** LAN URL + token + a scannable pairing code for the mobile app; nulls until started. */
  pairingInfo(): PairingInfo

  /** Forward one ravel operator-log entry (`ravel:log`) into the live timeline. */
  observeRavelLog(entry: RavelLogEntry): void
  /** Forward a roundtable snapshot; new turns since the last snapshot are recorded. */
  observeRoundtable(cfg: RoundtableConfig): void
  /** Forward a NORMAL (non-ravel) session status transition. */
  observeSessionStatus(session: Session, status: SessionStatus): void
  /** Forward a NORMAL (non-ravel) session exit. */
  observeSessionExit(session: Session, exitCode: number): void
  /** Forward a batch of session file-activity entries into the live timeline. */
  observeFileActivity(entries: SessionActivityEntry[]): void
}

/** Map a ravel-child dispatch (+ its session) onto the pure control-plane lifecycle. */
function dispatchLifecycle(status: RavelDispatchRecord['status']): WorkerControlState['lifecycle'] {
  if (status === 'starting') return 'starting'
  if (status === 'active') return 'running'
  return 'terminal'
}

/** Map a normal session's status onto the pure control-plane lifecycle. */
function sessionLifecycle(status: SessionStatus): WorkerControlState['lifecycle'] {
  if (status === 'starting') return 'starting'
  if (status === 'running' || status === 'needs-input') return 'running'
  return 'terminal'
}

/** Locate the ravel config + dispatch that owns a worker (child session) id. */
function findDispatchBySession(
  ravels: PublicRavelConfig[],
  sessionId: string
): { cfg: PublicRavelConfig; dispatch: RavelDispatchRecord } | null {
  for (const cfg of ravels) {
    const dispatch = cfg.dispatches.find((d) => d.sessionId === sessionId)
    if (dispatch) return { cfg, dispatch }
  }
  return null
}

/** Locate the ravel config + dispatch that produced a branch (for review context). */
function findDispatchByBranch(
  ravels: PublicRavelConfig[],
  branch: string
): { cfg: PublicRavelConfig; dispatch: RavelDispatchRecord } | null {
  for (const cfg of ravels) {
    // Prefer the newest matching dispatch (last attempt on that branch).
    const matches = cfg.dispatches.filter((d) => d.branch === branch)
    if (matches.length > 0) return { cfg, dispatch: matches[matches.length - 1] }
  }
  return null
}

/** Loopback web binds may remain plaintext; every other bind is TLS by default. */
function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase()
  return normalized === 'localhost' || normalized === '::1' || (isIP(normalized) === 4 && normalized.startsWith('127.'))
}

/**
 * Construct the Operations Core over injected app dependencies. Nothing binds a
 * port or touches the network until `start()` is called.
 */
export function createOperationsCore(appDeps: OperationsCoreDeps): OperationsCore {
  const journal = createEventJournal({ dir: join(appDeps.dataDir, 'events') })
  const automations = createAutomationStore(join(appDeps.dataDir, 'automations.json'))
  const feed = createLiveFeed(journal)

  const schedulerDep = appDeps.scheduler
  const scheduler: SchedulerRuntime | null = schedulerDep
    ? createSchedulerRuntime({
        automations,
        now: () => Date.now(),
        makeId: () => randomUUID(),
        makeOperationId: () => randomUUID(),
        loadLastChecked: () => readLastChecked(appDeps.dataDir),
        saveLastChecked: (at) => writeLastChecked(appDeps.dataDir, at),
        resolveRepoPath: (repoId) => appDeps.getRepos().find((r) => r.id === repoId)?.path ?? null,
        defaultHarness: schedulerDep.defaultHarness,
        createRavel: schedulerDep.createRavel,
        wakeTarget: schedulerDep.wakeTarget,
        setTimer: (fn, ms) => setTimeout(fn, ms),
        // DI boundary: the injected handle is exactly what setTimer returned (a
        // node timer); clearTimeout's param type is unexpressible as `unknown`.
        clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout)
      })
    : null

  /** Per-roundtable count of turns already recorded, so a snapshot records only new turns. */
  const roundtableTurns = new Map<string, number>()

  /** The recent timeline events attributed to one worker (child/normal session). */
  function recentEventsFor(sessionId: string): NormalizedEvent[] {
    const latest = feed.latest()
    const from = Math.max(0, latest - WORKER_DETAIL_SCAN)
    const read = feed.readAfter(from, WORKER_DETAIL_SCAN)
    return read.events.filter((e) => e.source.sessionId === sessionId).slice(-WORKER_DETAIL_EVENTS)
  }

  const deps: CoreDeps = {
    coreVersion: appDeps.coreVersion,
    storeSchemaVersion: STORE_SCHEMA_VERSION,
    capabilities: CAPABILITIES,
    automations,
    journal: {
      latest: () => feed.latest(),
      readAfter: (after, limit) => feed.readAfter(after, limit)
    },
    liveEvents: {
      subscribe: (onEvent) => feed.subscribe(onEvent)
    },
    workers: {
      detail(workerId) {
        const ravels = appDeps.listRavel()
        const session = appDeps.getSession(workerId)
        const owned = findDispatchBySession(ravels, workerId)
        if (owned) {
          const { cfg, dispatch } = owned
          const dependents = cfg.plan?.briefs.filter((b) => b.dependsOn.includes(dispatch.briefId)) ?? []
          const controlState: WorkerControlState = {
            kind: 'ravel-child',
            lifecycle: dispatchLifecycle(dispatch.status),
            responseInFlight: session?.status === 'running',
            hasParentRavel: true,
            dependentCount: dependents.length
          }
          return {
            controlState,
            latestEvents: recentEventsFor(workerId),
            dependentBriefs: dependents.map((b) => b.title)
          }
        }
        if (session && session.kind === 'normal') {
          const controlState: WorkerControlState = {
            kind: 'session',
            lifecycle: sessionLifecycle(session.status),
            responseInFlight: session.status === 'running',
            hasParentRavel: false,
            dependentCount: 0
          }
          return { controlState, latestEvents: recentEventsFor(workerId), dependentBriefs: [] }
        }
        return null
      }
    },
    async applyWorkerControl({ workerId, action, message }) {
      const settings = appDeps.getSettings()
      const owned = findDispatchBySession(appDeps.listRavel(), workerId)
      if (owned) {
        const { cfg, dispatch } = owned
        switch (action) {
          case 'message': {
            if (!message) throw new Error('message control requires a non-empty message')
            const result = await appDeps.ravel.steerChild(cfg.id, workerId, message, settings)
            return unwrapRavelResult(result)
          }
          case 'pause': {
            const paused = appDeps.ravel.pauseRavel(cfg.id)
            if (!paused) throw new Error(`ravel "${cfg.id}" is not live`)
            return
          }
          case 'resume': {
            const resumed = await appDeps.ravel.resumeRavel(cfg.id, settings)
            if (!resumed) throw new Error(`ravel "${cfg.id}" is not live`)
            return
          }
          case 'stop': {
            if (!appDeps.killSession(workerId)) throw new Error(`worker "${workerId}" is not live`)
            return
          }
          case 'retry': {
            const result = await appDeps.ravel.resumeInterruptedBrief(
              cfg.id,
              dispatch.planRevision,
              dispatch.briefId,
              settings
            )
            return unwrapRavelResult(result)
          }
          case 'archive': {
            if (!appDeps.ravel.archiveDispatch(cfg.id, workerId)) {
              throw new Error(`ravel "${cfg.id}" is not live`)
            }
            return
          }
          case 'detach': {
            if (!(await appDeps.ravel.detachChild(cfg.id, workerId, settings))) {
              throw new Error(`ravel "${cfg.id}" is not live`)
            }
            return
          }
          default: {
            const _exhaustive: never = action
            throw new Error(`unknown worker control "${_exhaustive as string}"`)
          }
        }
      }

      // A plain terminal/AI session (not a ravel child).
      const session = appDeps.getSession(workerId)
      if (session && session.kind === 'normal') {
        if (action === 'message') {
          if (!message) throw new Error('message control requires a non-empty message')
          if (!appDeps.writeToSession(workerId, message.endsWith('\n') ? message : `${message}\n`)) {
            throw new Error(`session "${workerId}" is not live`)
          }
          return
        }
        if (action === 'stop') {
          if (!appDeps.killSession(workerId)) throw new Error(`session "${workerId}" is not live`)
          return
        }
        throw new Error(`worker control "${action}" is not supported for a plain session`)
      }

      throw new Error(`unknown worker "${workerId}"`)
    },
    async applyReviewDecision(payload: ReviewDecisionPayload) {
      const repo = appDeps.getRepos().find((r) => r.id === payload.repoId)
      if (!repo) throw new Error(`unknown repo "${payload.repoId}"`)
      const repoPath = repo.path

      if (payload.decision === 'reject' || payload.decision === 'request-changes') {
        recordReviewEvent(payload, { landed: false })
        return { landed: false, decision: payload.decision }
      }

      // decision === 'land': add the rechecks the api-contract promises.
      const baseBranch = await appDeps.git.currentBranch(repoPath)
      if (baseBranch === '(detached)') {
        throw new Error('base repository is in detached HEAD; cannot land')
      }
      const baseNow = await appDeps.git.resolveCommit(repoPath, baseBranch)
      if (baseNow !== payload.baseCommit) {
        throw new Error('base has advanced since review; re-review before landing (stale base)')
      }
      const headNow = await appDeps.git.resolveCommit(repoPath, payload.branch)
      if (headNow !== payload.headCommit) {
        throw new Error('branch has advanced since review; re-review before landing (stale head)')
      }
      const changedFiles = await appDeps.git.changedFiles(repoPath, payload.branch, baseBranch)
      const digestNow = reviewDiffDigest({
        baseCommit: payload.baseCommit,
        headCommit: payload.headCommit,
        branch: payload.branch,
        changedFiles
      })
      if (digestNow !== payload.diffDigest) {
        throw new Error('diff changed since review; re-review before landing (stale diff)')
      }

      // Verification gate: an unverified or failed dispatch may only land on an
      // explicit operator confirmation.
      const owned = findDispatchByBranch(appDeps.listRavel(), payload.branch)
      const verification = owned?.dispatch.verification ?? null
      if ((!verification || !verification.ok) && payload.confirmed !== true) {
        throw new Error('verification is missing or failed; operator confirmation is required to land')
      }

      const result = await appDeps.git.mergeBranch(repoPath, payload.branch, baseBranch, {
        message: payload.note
      })
      if (!result.ok) {
        throw new Error(`merge failed: ${result.error}`)
      }
      recordReviewEvent(payload, { landed: true, commit: result.commit })
      return { landed: true, commit: result.commit, alreadyMerged: result.alreadyMerged }
    },
    async listReviews() {
      const repos = appDeps.getRepos()
      const items: ReviewListItem[] = []
      for (const cfg of appDeps.listRavel()) {
        const repo = repos.find((r) => r.id === cfg.repoId)
        if (!repo) continue
        const repoPath = repo.path
        let baseBranch: string
        let baseCommit: string
        try {
          baseBranch = await appDeps.git.currentBranch(repoPath)
          if (baseBranch === '(detached)') continue
          baseCommit = await appDeps.git.resolveCommit(repoPath, baseBranch)
        } catch {
          continue
        }
        // Newest dispatch per branch only; a branch with no work ahead is skipped.
        const seen = new Set<string>()
        for (const dispatch of [...cfg.dispatches].reverse()) {
          if (!dispatch.branch || seen.has(dispatch.branch)) continue
          seen.add(dispatch.branch)
          if (dispatch.status === 'starting' || dispatch.status === 'active') continue
          try {
            const headCommit = await appDeps.git.resolveCommit(repoPath, dispatch.branch)
            const changedFiles = await appDeps.git.changedFiles(repoPath, dispatch.branch, baseBranch)
            if (changedFiles.length === 0) continue
            const brief = cfg.plan?.briefs.find((b) => b.id === dispatch.briefId) ?? null
            items.push({
              repoId: cfg.repoId,
              ravelId: cfg.id,
              briefId: dispatch.briefId,
              title: brief?.title ?? dispatch.briefId,
              branch: dispatch.branch,
              baseCommit,
              headCommit,
              diffDigest: reviewDiffDigest({ baseCommit, headCommit, branch: dispatch.branch, changedFiles }),
              changedFiles,
              verification: dispatch.verification,
              landable: true
            })
          } catch {
            // Branch/worktree gone or unreadable — not reviewable; skip it.
          }
        }
      }
      return items
    },
    async diffReview(repoId, branch) {
      const repo = appDeps.getRepos().find((r) => r.id === repoId)
      if (!repo) throw new Error(`unknown repo "${repoId}"`)
      const repoPath = repo.path
      const baseBranch = await appDeps.git.currentBranch(repoPath)
      if (baseBranch === '(detached)') {
        throw new Error('base repository is in detached HEAD; cannot diff')
      }
      const baseCommit = await appDeps.git.resolveCommit(repoPath, baseBranch)
      const headCommit = await appDeps.git.resolveCommit(repoPath, branch)
      // Digest over the same name-only file set as review.list, so a client can
      // compare it to the list item it opened and detect a base/head/content change.
      const changed = await appDeps.git.changedFiles(repoPath, branch, baseBranch)
      const diffDigest = reviewDiffDigest({ baseCommit, headCommit, branch, changedFiles: changed })

      const metas = await appDeps.git.reviewFileList(repoPath, branch, baseBranch)
      const files: ReviewFileDiff[] = []
      let usedBytes = 0
      let truncated = false
      for (const meta of metas) {
        const base = {
          path: meta.path,
          oldPath: meta.oldPath,
          status: meta.status,
          additions: meta.additions,
          deletions: meta.deletions
        }
        if (meta.binary) {
          files.push({ ...base, content: 'binary', patch: '' })
          continue
        }
        if (usedBytes >= MAX_REVIEW_DIFF_BYTES) {
          files.push({ ...base, content: 'truncated', patch: '' })
          truncated = true
          continue
        }
        const patch = await appDeps.git.fileUnifiedDiff(repoPath, branch, baseBranch, meta.path, meta.oldPath)
        if (patch.length > MAX_FILE_DIFF_BYTES) {
          files.push({ ...base, content: 'oversized', patch: '' })
          continue
        }
        usedBytes += patch.length
        files.push({ ...base, content: 'text', patch })
      }
      return { repoId, branch, baseBranch, baseCommit, headCommit, diffDigest, files, truncated }
    },
    operations: new Map<string, CommandResult>()
  }

  /** Best-effort audit event for a review decision; recorded only when a ravel owns the branch. */
  function recordReviewEvent(payload: ReviewDecisionPayload, outcome: { landed: boolean; commit?: string | null }): void {
    const owned = findDispatchByBranch(appDeps.listRavel(), payload.branch)
    if (!owned) return
    const { cfg, dispatch } = owned
    const kind = outcome.landed ? 'commit' : 'rejection'
    const summary = outcome.landed
      ? `landed ${payload.branch}${outcome.commit ? ` (${outcome.commit.slice(0, 8)})` : ''}`
      : `${payload.decision} ${payload.branch}${payload.note ? `: ${payload.note}` : ''}`
    const event: UnsequencedEvent = {
      id: `review:${payload.branch}:${payload.headCommit}:${payload.decision}`,
      timestamp: Date.now(),
      repoId: payload.repoId,
      rootWorkflowId: cfg.id,
      rootWorkflowKind: 'ravel',
      parentWorkerId: null,
      workerId: dispatch.sessionId,
      workerKind: dispatch.sessionId ? 'ravel-child' : null,
      role: null,
      harness: null,
      model: null,
      attempt: 1,
      kind,
      summary,
      evidenceRefs: [],
      source: { ravelId: cfg.id, briefId: dispatch.briefId, sessionId: dispatch.sessionId ?? undefined }
    }
    try {
      feed.record(event)
    } catch (error) {
      console.error('[operations] failed to record review event', error)
    }
  }

  const services = createCoreServices(deps)
  const webHost = appDeps.webHost ?? '127.0.0.1'
  const nonLoopback = !isLoopbackHost(webHost)
  const tlsEnabled = appDeps.webTls ?? nonLoopback
  // Non-loopback binds default to HTTPS. An explicit CONDUCTOR_WEB_TLS=0 is an
  // opt-out for a trusted LAN (e.g. the Android WebView client, which cannot
  // trust a self-signed cert): allowed, but loudly warned. The bearer token
  // still gates every request; only the transport is cleartext.
  if (nonLoopback && !tlsEnabled) {
    console.warn(
      '[operations] WARNING: serving the web API over CLEARTEXT on a non-loopback interface ' +
        '(CONDUCTOR_WEB_TLS=0). The access token and all traffic are unencrypted — only use this on a trusted LAN.'
    )
  }
  const tls = tlsEnabled ? loadOrCreateTls(appDeps.dataDir) : null
  const webToken = appDeps.webToken && appDeps.webToken.length > 0 ? appDeps.webToken : null
  const server = createWebServer(services, {
    host: webHost,
    staticDir: appDeps.webStaticDir,
    token: webToken ?? undefined,
    tls: tls ? { key: tls.key, cert: tls.cert } : undefined
  })
  const scheme = tls ? 'https' : 'http'
  return {
    deps,
    services,
    async start() {
      const bound = await server.listen(appDeps.webPort)
      publishEndpoint(appDeps.dataDir, bound, webHost, webToken ?? undefined, scheme)
      if (scheduler) {
        scheduler.start().catch((error) => console.error('[operations] scheduler start failed', error))
      }
      return bound
    },
    async stop() {
      scheduler?.stop()
      await server.close()
    },
    port() {
      return server.port
    },
    pairingInfo() {
      const bound = server.port
      if (bound === null) return { url: null, token: null, code: null }
      const host = resolvePairingHost(webHost)
      const url = `${scheme}://${host}:${bound}`
      const token = webToken
      const payload: { u: string; t: string; f?: string } = { u: url, t: token ?? '' }
      if (tls) payload.f = tls.fingerprint
      const code = `C1:${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`
      return { url, token, code }
    },
    observeRavelLog(entry) {
      try {
        feed.record(normalizeRavelLog(entry, appDeps.getRavel(entry.ravelId) ?? null))
      } catch (error) {
        console.error('[operations] failed to record ravel log event', error)
      }
      // A completed Ravel settles any scheduled occurrence that spawned it.
      if (scheduler && entry.event === 'complete') scheduler.settleRun(entry.ravelId, true)
    },
    observeRoundtable(cfg) {
      try {
        const seen = roundtableTurns.get(cfg.id) ?? 0
        if (cfg.turns.length <= seen) {
          roundtableTurns.set(cfg.id, cfg.turns.length)
          return
        }
        for (const turn of cfg.turns.slice(seen)) {
          feed.record(normalizeRoundtableTurn(cfg, turn))
        }
        roundtableTurns.set(cfg.id, cfg.turns.length)
      } catch (error) {
        console.error('[operations] failed to record roundtable event', error)
      }
    },
    observeSessionStatus(session, status) {
      if (session.kind !== 'normal') return
      try {
        feed.record(normalizeSessionStatus(session, status))
      } catch (error) {
        console.error('[operations] failed to record session status event', error)
      }
    },
    observeSessionExit(session, exitCode) {
      if (session.kind !== 'normal') return
      try {
        feed.record(normalizeSessionExit(session, exitCode))
      } catch (error) {
        console.error('[operations] failed to record session exit event', error)
      }
    },
    observeFileActivity(entries) {
      for (const entry of entries) {
        const session = appDeps.getSession(entry.sessionId)
        if (!session) continue
        try {
          feed.record(normalizeFileActivity(entry, session))
        } catch (error) {
          console.error('[operations] failed to record file activity event', error)
        }
      }
    }
  }
}

/** Turn a `RavelActionResult | undefined` into a resolved value or a thrown error. */
function unwrapRavelResult(result: RavelActionResult | undefined): unknown {
  if (!result) throw new Error('ravel is not live')
  if (!result.ok) throw new Error(result.error.message ?? result.error.code)
  return result.ravel
}

/**
 * Publish the bound loopback port so a dev web client (Phase 2) and the future
 * Capacitor shell can discover it without a hardcoded value. Best-effort: a
 * failure to write the hint file never fails startup.
 */
function publishEndpoint(dataDir: string, port: number, host: string, token?: string, scheme: 'http' | 'https' = 'http'): void {
  const shown = host === '0.0.0.0' ? '<this-machine-LAN-IP>' : host
  console.log(`[operations] web server listening on ${scheme}://${shown}:${port}`)
  if (token) console.log('[operations] access token configured')
  try {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(
      join(dataDir, 'web-endpoint.json'),
      JSON.stringify({ host, port, scheme }, null, 2)
    )
  } catch (error) {
    console.error('[operations] failed to publish web endpoint hint', error)
  }
}

/** Read the persisted scheduler `lastCheckedAt` (catch-up bound across restarts), or null. */
function readLastChecked(dataDir: string): EpochMs | null {
  try {
    const file = join(dataDir, 'scheduler.json')
    if (!existsSync(file)) return null
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed && typeof parsed === 'object' && 'lastCheckedAt' in parsed && typeof parsed.lastCheckedAt === 'number') {
      return parsed.lastCheckedAt
    }
  } catch {
    // A missing/corrupt scheduler-state file just means "no catch-up bound".
  }
  return null
}

/** Persist the scheduler `lastCheckedAt`. Best-effort; a failure never breaks a tick. */
function writeLastChecked(dataDir: string, at: EpochMs): void {
  try {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, 'scheduler.json'), JSON.stringify({ lastCheckedAt: at }))
  } catch (error) {
    console.error('[operations] failed to persist scheduler state', error)
  }
}

/** The host to advertise for pairing: a real LAN IPv4 when bound to all interfaces, else the bound host. */
function resolvePairingHost(webHost: string): string {
  if (webHost !== '0.0.0.0' && webHost !== '::') return webHost
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address
    }
  }
  return '127.0.0.1'
}
