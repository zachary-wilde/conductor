import { describe, expect, it, vi } from 'vitest'
import { createCoreServices } from './core-services'
import type { CoreDeps } from './core-services'
import { API_VERSION } from './api-contract'
import type { ClientQuery, CommandResult, EventStreamFrame } from './api-contract'
import type { WorkerControlState } from './worker-controls'
import type { AutomationDefinition, AutomationRevision, Occurrence } from './types'
import type { AutomationStore } from './automation-store'
import type { EventCursor, JournalReadResult, NormalizedEvent } from './events'

// Fixed epoch — never Date.now(). Timestamps here are arbitrary ms.
const T0 = 1_700_000_000_000

const clone = <T>(x: T): T => structuredClone(x)

/** A fully-populated NormalizedEvent from a cursor; any field overridable. */
function mkEvent(cursor: number, over: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    id: `evt-${cursor}`,
    cursor,
    timestamp: T0 + cursor * 60_000,
    repoId: null,
    rootWorkflowId: 'wf-1',
    rootWorkflowKind: 'session',
    parentWorkerId: null,
    workerId: 'w-1',
    workerKind: 'session',
    role: null,
    harness: 'claude',
    model: null,
    attempt: 1,
    kind: 'lifecycle',
    summary: `event ${cursor}`,
    evidenceRefs: [],
    source: {},
    ...over
  }
}

/** A control-plane state with sensible defaults; any field overridable. */
function ctrlState(over: Partial<WorkerControlState> = {}): WorkerControlState {
  return {
    kind: 'session',
    lifecycle: 'running',
    responseInFlight: false,
    hasParentRavel: false,
    dependentCount: 0,
    ...over
  }
}

/** A fully-populated automation revision; any field overridable. */
function mkRevision(over: Partial<AutomationRevision> = {}): AutomationRevision {
  return {
    id: 'rev-1',
    kind: 'heartbeat',
    title: 'Heartbeat',
    enabled: true,
    cadence: { expression: '*/5 * * * *', timezone: 'UTC' },
    targetId: 'ravel-1',
    prompt: 'check in',
    repoId: 'repo-1',
    harness: 'claude',
    model: 'claude-sonnet',
    ravelRoster: [],
    verificationCommand: null,
    perRunTokenCeiling: 1000,
    concurrency: 'single-flight',
    stopCondition: { kind: 'until-disabled' },
    approval: { createdBy: 'operator', createdAt: T0, approvedAt: T0 },
    ...over
  }
}

/** A definition pointing at its first revision as current; overridable. */
function mkDefinition(over: Partial<AutomationDefinition> = {}): AutomationDefinition {
  const revisions = over.revisions ?? [mkRevision()]
  return {
    id: 'auto-1',
    currentRevisionId: over.currentRevisionId ?? revisions[0].id,
    revisions,
    ...over
  }
}

/** A fully-populated occurrence; any field overridable. */
function mkOccurrence(over: Partial<Occurrence> = {}): Occurrence {
  return {
    id: 'o-1',
    automationId: 'auto-1',
    revisionId: 'rev-1',
    state: 'due',
    scheduledAt: T0,
    startedAt: null,
    endedAt: null,
    isCatchUp: false,
    missedCount: 0,
    runId: null,
    operationId: 'spawn-op',
    failure: null,
    tokensUsed: null,
    ...over
  }
}

/**
 * In-memory AutomationStore that mirrors the real contract (getters return deep
 * clones) and records the mutating calls so tests can assert exact arguments.
 */
class FakeStore implements AutomationStore {
  private defs = new Map<string, AutomationDefinition>()
  private occs: Occurrence[] = []
  readonly putDefinitionCalls: AutomationDefinition[] = []
  readonly addRevisionCalls: { automationId: string; revision: AutomationRevision }[] = []
  readonly setCurrentRevisionCalls: { automationId: string; revisionId: string }[] = []

  getLoadError(): Error | null {
    return null
  }
  seed(def: AutomationDefinition): void {
    this.defs.set(def.id, clone(def))
  }
  seedOccurrence(occ: Occurrence): void {
    this.occs.push(clone(occ))
  }
  listDefinitions(): AutomationDefinition[] {
    return [...this.defs.values()].map(clone)
  }
  getDefinition(id: string): AutomationDefinition | null {
    const d = this.defs.get(id)
    return d ? clone(d) : null
  }
  putDefinition(def: AutomationDefinition): void {
    this.putDefinitionCalls.push(clone(def))
    this.defs.set(def.id, clone(def))
  }
  addRevision(automationId: string, revision: AutomationRevision): void {
    this.addRevisionCalls.push({ automationId, revision: clone(revision) })
    const d = this.defs.get(automationId)
    if (d) {
      const next = clone(d)
      next.revisions.push(clone(revision))
      this.defs.set(automationId, next)
    }
  }
  setCurrentRevision(automationId: string, revisionId: string): void {
    this.setCurrentRevisionCalls.push({ automationId, revisionId })
    const d = this.defs.get(automationId)
    if (d) {
      const next = clone(d)
      next.currentRevisionId = revisionId
      this.defs.set(automationId, next)
    }
  }
  listOccurrences(automationId?: string): Occurrence[] {
    return this.occs
      .filter((o) => automationId == null || o.automationId === automationId)
      .map(clone)
  }
  putOccurrence(occ: Occurrence): void {
    const i = this.occs.findIndex((o) => o.id === occ.id)
    if (i >= 0) this.occs[i] = clone(occ)
    else this.occs.push(clone(occ))
  }
  getOccurrence(id: string): Occurrence | null {
    const o = this.occs.find((x) => x.id === id)
    return o ? clone(o) : null
  }
}

/** A scriptable live-event feed: the test emits through `emit`. */
function makeLiveEvents(): {
  live: CoreDeps['liveEvents']
  emit: (e: NormalizedEvent) => void
  readonly detached: boolean
} {
  let sink: ((e: NormalizedEvent) => void) | null = null
  let detached = false
  return {
    live: {
      subscribe(onEvent) {
        sink = onEvent
        return () => {
          detached = true
          sink = null
        }
      }
    },
    emit: (e) => sink?.(e),
    get detached() {
      return detached
    }
  }
}

/** A worker supervisor projection keyed by workerId. */
function makeWorkers(
  entries: Record<
    string,
    { controlState: WorkerControlState; latestEvents: NormalizedEvent[]; dependentBriefs?: string[] }
  > = {}
): CoreDeps['workers'] {
  return {
    detail: (workerId) => {
      const entry = entries[workerId]
      return entry ? { ...entry, dependentBriefs: entry.dependentBriefs ?? [] } : null
    }
  }
}

interface DepsOverrides {
  store?: FakeStore
  latestCursor?: EventCursor
  readAfter?: (after: EventCursor, limit?: number) => JournalReadResult
  workers?: CoreDeps['workers']
  capabilities?: string[]
  applyWorkerControl?: CoreDeps['applyWorkerControl']
  applyReviewDecision?: CoreDeps['applyReviewDecision']
  listReviews?: CoreDeps['listReviews']
  diffReview?: CoreDeps['diffReview']
}

/**
 * Build a CoreDeps with sensible fakes and spy applyWorkerControl / applyReviewDecision.
 * Returns the fakes alongside deps so tests can drive and assert them.
 */
function makeDeps(over: DepsOverrides = {}) {
  const store = over.store ?? new FakeStore()
  let latestCursor: EventCursor = over.latestCursor ?? 0
  const readAfter: CoreDeps['journal']['readAfter'] =
    over.readAfter ??
    ((_after: EventCursor, _limit?: number) => ({ events: [], latestCursor, gap: null }))
  const liveCtl = makeLiveEvents()
  const workers = over.workers ?? makeWorkers()
  const applyWorkerControl = vi.fn(over.applyWorkerControl ?? (async () => 'applied'))
  const applyReviewDecision = vi.fn(over.applyReviewDecision ?? (async () => 'merged'))
  const deps: CoreDeps = {
    coreVersion: 'test-core',
    storeSchemaVersion: 3,
    capabilities: over.capabilities ?? ['command', 'query', 'events'],
    automations: store,
    journal: { latest: () => latestCursor, readAfter },
    liveEvents: liveCtl.live,
    workers,
    applyWorkerControl,
    applyReviewDecision,
    listReviews: vi.fn(over.listReviews ?? (async () => [])),
    diffReview: vi.fn(
      over.diffReview ??
        (async (repoId: string, branch: string) => ({
          repoId,
          branch,
          baseBranch: 'main',
          baseCommit: 'base',
          headCommit: 'head',
          diffDigest: 'digest',
          files: [],
          truncated: false
        }))
    ),
    operations: new Map<string, CommandResult>()
  }
  return {
    deps,
    store,
    liveCtl,
    workers,
    applyWorkerControl,
    applyReviewDecision,
    setLatestCursor: (n: EventCursor) => {
      latestCursor = n
    }
  }
}

const runningWorker = () => ({
  'w-1': { controlState: ctrlState({ lifecycle: 'running' }), latestEvents: [] }
})

describe('createCoreServices', () => {
  describe('handshake', () => {
    it('reports coreVersion, apiVersion=API_VERSION, storeSchemaVersion, capabilities, and the journal cursor', () => {
      const { deps } = makeDeps({ latestCursor: 42, capabilities: ['a', 'b'] })
      const services = createCoreServices(deps)

      expect(services.handshake()).toEqual({
        coreVersion: 'test-core',
        apiVersion: API_VERSION,
        storeSchemaVersion: 3,
        capabilities: ['a', 'b'],
        cursor: 42
      })
    })
  })

  describe('handleCommand — worker.control', () => {
    it('applies an available action and forwards it to applyWorkerControl', async () => {
      const { deps, applyWorkerControl } = makeDeps({ workers: makeWorkers(runningWorker()) })
      const services = createCoreServices(deps)

      const res = await services.handleCommand({
        operationId: 'op-1',
        name: 'worker.control',
        payload: { workerId: 'w-1', action: 'message', message: 'hello' }
      })

      expect(res).toEqual({ ok: true, operationId: 'op-1', deduplicated: false })
      expect(applyWorkerControl).toHaveBeenCalledTimes(1)
      expect(applyWorkerControl).toHaveBeenCalledWith({
        workerId: 'w-1',
        action: 'message',
        message: 'hello'
      })
    })

    it('returns unknown-worker and never calls applyWorkerControl', async () => {
      const { deps, applyWorkerControl } = makeDeps({ workers: makeWorkers({}) })
      const services = createCoreServices(deps)

      const res = await services.handleCommand({
        operationId: 'op-x',
        name: 'worker.control',
        payload: { workerId: 'nope', action: 'message' }
      })

      expect(res.ok).toBe(false)
      expect(res.operationId).toBe('op-x')
      expect(res.error?.code).toBe('unknown-worker')
      expect(applyWorkerControl).not.toHaveBeenCalled()
    })

    it('returns invalid-control for an action unavailable in the current state', async () => {
      // A running session offers message/pause/stop; retry is terminal-only.
      const { deps, applyWorkerControl } = makeDeps({ workers: makeWorkers(runningWorker()) })
      const services = createCoreServices(deps)

      const res = await services.handleCommand({
        operationId: 'op-x',
        name: 'worker.control',
        payload: { workerId: 'w-1', action: 'retry' }
      })

      expect(res.error?.code).toBe('invalid-control')
      expect(applyWorkerControl).not.toHaveBeenCalled()
    })

    it('returns confirmation-required for a destructive action without confirmed', async () => {
      const { deps, applyWorkerControl } = makeDeps({ workers: makeWorkers(runningWorker()) })
      const services = createCoreServices(deps)

      const res = await services.handleCommand({
        operationId: 'op-x',
        name: 'worker.control',
        payload: { workerId: 'w-1', action: 'stop' }
      })

      expect(res.error?.code).toBe('confirmation-required')
      expect(applyWorkerControl).not.toHaveBeenCalled()
    })

    it('proceeds with a destructive action when confirmed is true', async () => {
      const { deps, applyWorkerControl } = makeDeps({ workers: makeWorkers(runningWorker()) })
      const services = createCoreServices(deps)

      const res = await services.handleCommand({
        operationId: 'op-c',
        name: 'worker.control',
        payload: { workerId: 'w-1', action: 'stop', confirmed: true }
      })

      expect(res.ok).toBe(true)
      expect(applyWorkerControl).toHaveBeenCalledWith({
        workerId: 'w-1',
        action: 'stop',
        message: undefined
      })
    })
  })

  describe('handleCommand — automations', () => {
    it('automation.upsert puts the definition', async () => {
      const store = new FakeStore()
      const { deps } = makeDeps({ store })
      const services = createCoreServices(deps)
      const def = mkDefinition({ id: 'a-9' })

      const res = await services.handleCommand({
        operationId: 'op-u',
        name: 'automation.upsert',
        payload: { definition: def }
      })

      expect(res.ok).toBe(true)
      expect(store.putDefinitionCalls).toEqual([def])
    })

    it('automation.addRevision appends without changing the current revision', async () => {
      const store = new FakeStore()
      store.seed(
        mkDefinition({
          id: 'a-1',
          currentRevisionId: 'rev-1',
          revisions: [mkRevision({ id: 'rev-1' })]
        })
      )
      const { deps } = makeDeps({ store })
      const services = createCoreServices(deps)
      const rev2 = mkRevision({ id: 'rev-2', title: 'V2' })

      const res = await services.handleCommand({
        operationId: 'op-a',
        name: 'automation.addRevision',
        payload: { automationId: 'a-1', revision: rev2 }
      })

      expect(res.ok).toBe(true)
      expect(store.addRevisionCalls).toEqual([{ automationId: 'a-1', revision: rev2 }])
      expect(store.getDefinition('a-1')?.currentRevisionId).toBe('rev-1')
    })

    it('automation.approve calls setCurrentRevision with the exact ids', async () => {
      const store = new FakeStore()
      store.seed(
        mkDefinition({
          id: 'a-1',
          currentRevisionId: 'rev-1',
          revisions: [mkRevision({ id: 'rev-1' }), mkRevision({ id: 'rev-2' })]
        })
      )
      const { deps } = makeDeps({ store })
      const services = createCoreServices(deps)

      const res = await services.handleCommand({
        operationId: 'op-p',
        name: 'automation.approve',
        payload: { automationId: 'a-1', revisionId: 'rev-2' }
      })

      expect(res.ok).toBe(true)
      expect(store.setCurrentRevisionCalls).toEqual([{ automationId: 'a-1', revisionId: 'rev-2' }])
    })

    it('automation.setEnabled flips only the current revision enabled flag', async () => {
      const store = new FakeStore()
      store.seed(
        mkDefinition({
          id: 'a-1',
          currentRevisionId: 'rev-1',
          revisions: [mkRevision({ id: 'rev-1', enabled: true }), mkRevision({ id: 'rev-2' })]
        })
      )
      const { deps } = makeDeps({ store })
      const services = createCoreServices(deps)

      const res = await services.handleCommand({
        operationId: 'op-e',
        name: 'automation.setEnabled',
        payload: { automationId: 'a-1', enabled: false }
      })

      expect(res.ok).toBe(true)
      expect(store.putDefinitionCalls).toHaveLength(1)
      const put = store.putDefinitionCalls[0]
      expect(put.currentRevisionId).toBe('rev-1')
      const current = put.revisions.find((r) => r.id === 'rev-1')
      const other = put.revisions.find((r) => r.id === 'rev-2')
      expect(current?.enabled).toBe(false)
      // current revision identity and other fields are preserved.
      expect(current?.title).toBe('Heartbeat')
      // other revisions are untouched.
      expect(other?.enabled).toBe(true)
    })

    it('automation.setEnabled errors on an unknown automation', async () => {
      const store = new FakeStore()
      const { deps } = makeDeps({ store })
      const services = createCoreServices(deps)

      const res = await services.handleCommand({
        operationId: 'op-e',
        name: 'automation.setEnabled',
        payload: { automationId: 'missing', enabled: true }
      })

      expect(res.ok).toBe(false)
      expect(res.error?.code).toBe('unknown-automation')
      expect(store.putDefinitionCalls).toHaveLength(0)
    })
  })

  describe('handleCommand — review.decide', () => {
    it('forwards the payload to applyReviewDecision', async () => {
      const { deps, applyReviewDecision } = makeDeps()
      const services = createCoreServices(deps)
      const payload = {
        repoId: 'r',
        branch: 'b',
        baseCommit: 'c1',
        headCommit: 'c2',
        diffDigest: 'd',
        decision: 'land' as const,
        confirmed: true
      }

      const res = await services.handleCommand({
        operationId: 'op-r',
        name: 'review.decide',
        payload
      })

      expect(res.ok).toBe(true)
      expect(applyReviewDecision).toHaveBeenCalledTimes(1)
      expect(applyReviewDecision).toHaveBeenCalledWith(payload)
    })
  })

  describe('handleCommand — error safety & idempotency', () => {
    it('a thrown dep error becomes a safe command-failed result with no stack leak', async () => {
      const boom = new Error('merge failed')
      boom.stack = 'SECRET INTERNAL STACK TRACE /home/user/secret.js'
      const { deps, applyWorkerControl } = makeDeps({
        workers: makeWorkers(runningWorker()),
        applyWorkerControl: async () => {
          throw boom
        }
      })
      const services = createCoreServices(deps)

      const res = await services.handleCommand({
        operationId: 'op-f',
        name: 'worker.control',
        payload: { workerId: 'w-1', action: 'message' }
      })

      expect(res.ok).toBe(false)
      expect(res.operationId).toBe('op-f')
      expect(res.deduplicated).toBe(false)
      expect(res.error?.code).toBe('command-failed')
      expect(res.error?.message).toBe('merge failed')
      // The result carries only code+message; internals stay in the logs.
      expect(JSON.stringify(res)).not.toContain('SECRET')
      expect(applyWorkerControl).toHaveBeenCalledTimes(1)
    })

    it('a retried operationId returns the prior result with deduplicated:true and runs the work once', async () => {
      const { deps, applyWorkerControl } = makeDeps({ workers: makeWorkers(runningWorker()) })
      const services = createCoreServices(deps)
      const cmd = {
        operationId: 'op-dedup',
        name: 'worker.control' as const,
        payload: { workerId: 'w-1', action: 'message' as const, message: 'x' }
      }

      const r1 = await services.handleCommand(cmd)
      const r2 = await services.handleCommand(cmd)

      expect(r1).toEqual({ ok: true, operationId: 'op-dedup', deduplicated: false })
      expect(r2.ok).toBe(true)
      expect(r2.deduplicated).toBe(true)
      expect(r2.operationId).toBe('op-dedup')
      expect(applyWorkerControl).toHaveBeenCalledTimes(1)
    })

    it('a retried operationId that originally errored returns the same error, deduplicated', async () => {
      const { deps } = makeDeps({ workers: makeWorkers({}) })
      const services = createCoreServices(deps)
      const cmd = {
        operationId: 'op-err-dedup',
        name: 'worker.control' as const,
        payload: { workerId: 'ghost', action: 'message' as const }
      }

      const r1 = await services.handleCommand(cmd)
      const r2 = await services.handleCommand(cmd)

      expect(r1.error?.code).toBe('unknown-worker')
      expect(r1.deduplicated).toBe(false)
      expect(r2.error?.code).toBe('unknown-worker')
      expect(r2.deduplicated).toBe(true)
    })
  })

  describe('handleQuery', () => {
    it('timeline.read forwards afterCursor and limit to journal.readAfter', async () => {
      const events = [mkEvent(1), mkEvent(2)]
      const readAfter = vi.fn(
        (_after: EventCursor, _limit?: number): JournalReadResult => ({
          events,
          latestCursor: 2,
          gap: null
        })
      )
      const { deps } = makeDeps({ readAfter })
      const services = createCoreServices(deps)

      const res = await services.handleQuery({
        name: 'timeline.read',
        afterCursor: 0,
        limit: 10
      })

      expect(readAfter).toHaveBeenCalledWith(0, 10)
      expect(res).toEqual({ events, latestCursor: 2, gap: null })
    })

    it('worker.detail builds a view with availableControls for the state', async () => {
      const latest = [mkEvent(5, { workerId: 'w-1' })]
      const workers = makeWorkers({
        'w-1': { controlState: ctrlState({ lifecycle: 'paused' }), latestEvents: latest }
      })
      const { deps } = makeDeps({ workers })
      const services = createCoreServices(deps)

      const res = await services.handleQuery({ name: 'worker.detail', workerId: 'w-1' })

      expect(res).toEqual({
        workerId: 'w-1',
        controlState: ctrlState({ lifecycle: 'paused' }),
        availableControls: ['message', 'resume', 'stop'],
        latestEvents: latest,
        dependentBriefs: []
      })
    })

    it('worker.detail throws on an unknown worker', async () => {
      const { deps } = makeDeps({ workers: makeWorkers({}) })
      const services = createCoreServices(deps)

      await expect(
        services.handleQuery({ name: 'worker.detail', workerId: 'ghost' })
      ).rejects.toThrow(/Unknown worker/)
    })

    it('automation.list joins definitions with their current revision and occurrences', async () => {
      const store = new FakeStore()
      const r1 = mkRevision({ id: 'rev-1' })
      store.seed(mkDefinition({ id: 'a-1', currentRevisionId: 'rev-1', revisions: [r1] }))
      store.seedOccurrence(mkOccurrence({ id: 'o-1', automationId: 'a-1', revisionId: 'rev-1' }))
      store.seedOccurrence(mkOccurrence({ id: 'o-2', automationId: 'a-1' }))
      // An occurrence for a different automation must be excluded.
      store.seedOccurrence(mkOccurrence({ id: 'o-3', automationId: 'other' }))
      const { deps } = makeDeps({ store })
      const services = createCoreServices(deps)

      const res = await services.handleQuery({ name: 'automation.list' } as ClientQuery)

      expect(res).toHaveLength(1)
      expect(res[0].definition.id).toBe('a-1')
      expect(res[0].currentRevision.id).toBe('rev-1')
      expect(res[0].recentOccurrences.map((o) => o.id)).toEqual(['o-1', 'o-2'])
    })
  })

  describe('subscribe', () => {
    it('replays readAfter events synchronously then forwards live-emitted events', () => {
      const replay = [mkEvent(1), mkEvent(2)]
      const { deps, liveCtl } = makeDeps({
        readAfter: () => ({ events: replay, latestCursor: 2, gap: null })
      })
      const services = createCoreServices(deps)
      const frames: EventStreamFrame[] = []

      const unsub = services.subscribe(0, (f) => frames.push(f))

      // Replay is synchronous within the subscribe call.
      expect(frames).toEqual([
        { type: 'event', event: replay[0] },
        { type: 'event', event: replay[1] }
      ])

      const live = mkEvent(3)
      liveCtl.emit(live)
      expect(frames[2]).toEqual({ type: 'event', event: live })

      unsub()
    })

    it('emits a gap frame when readAfter reports a rotated-out cursor', () => {
      const { deps } = makeDeps({
        readAfter: () => ({
          events: [],
          latestCursor: 10,
          gap: { requestedAfter: 0, earliestAvailable: 7 }
        })
      })
      const services = createCoreServices(deps)
      const frames: EventStreamFrame[] = []

      services.subscribe(0, (f) => frames.push(f))

      expect(frames).toEqual([{ type: 'gap', earliestAvailable: 7 }])
    })

    it('emits a gap frame before any retained events on a partial replay', () => {
      const retained = [mkEvent(8)]
      const { deps } = makeDeps({
        readAfter: () => ({
          events: retained,
          latestCursor: 8,
          gap: { requestedAfter: 0, earliestAvailable: 7 }
        })
      })
      const services = createCoreServices(deps)
      const frames: EventStreamFrame[] = []

      services.subscribe(0, (f) => frames.push(f))

      expect(frames).toEqual([
        { type: 'gap', earliestAvailable: 7 },
        { type: 'event', event: retained[0] }
      ])
    })

    it('the returned unsubscribe detaches the live feed', () => {
      const { deps, liveCtl } = makeDeps()
      const services = createCoreServices(deps)
      const frames: EventStreamFrame[] = []

      const unsub = services.subscribe(0, (f) => frames.push(f))
      unsub()
      // A live event emitted after unsubscribe is dropped.
      liveCtl.emit(mkEvent(99))

      expect(frames).toEqual([])
      expect(liveCtl.detached).toBe(true)
    })
  })
})
