// Proves the scheduler runtime actually FIRES: given a due automation it persists
// the occurrence, spawns a Ravel (or wakes a target), transitions the occurrence,
// arms the next wake, holds single-flight, reconciles on restart, and settles a
// completed run. Everything is injected (store, clock, ids, spawn, timers), so the
// tick is driven deterministically without fs, real timers, or a real Ravel.

import { describe, expect, it, vi } from 'vitest'
import { createSchedulerRuntime } from './scheduler-runtime'
import type { SchedulerRuntimeDeps } from './scheduler-runtime'
import type { AutomationStore } from './automation-store'
import type { AutomationDefinition, AutomationRevision, Occurrence } from './types'
import type { CreateRavelRequest } from '@shared/types'

const MINUTE = 60_000
const NOW = 1_700_000_040_000 // arbitrary ms, mid-minute

function revision(over: Partial<AutomationRevision> = {}): AutomationRevision {
  return {
    id: 'rev-1',
    kind: 'schedule',
    title: 'Nightly',
    enabled: true,
    cadence: { expression: '* * * * *', timezone: 'UTC' },
    targetId: null,
    prompt: 'do the thing',
    repoId: 'repo-1',
    harness: 'claude',
    model: null,
    ravelRoster: [],
    verificationCommand: null,
    perRunTokenCeiling: null,
    concurrency: 'single-flight',
    stopCondition: { kind: 'until-disabled' },
    approval: { createdBy: 'operator', createdAt: 0, approvedAt: 0 },
    ...over
  }
}

function definition(rev: AutomationRevision, id = 'auto-1'): AutomationDefinition {
  return { id, currentRevisionId: rev.id, revisions: [rev] }
}

function occurrence(over: Partial<Occurrence> = {}): Occurrence {
  return {
    id: 'occ-seed',
    automationId: 'auto-1',
    revisionId: 'rev-1',
    state: 'running',
    scheduledAt: NOW - MINUTE,
    startedAt: NOW - MINUTE,
    endedAt: null,
    isCatchUp: false,
    missedCount: 0,
    runId: null,
    operationId: 'op-seed',
    failure: null,
    tokensUsed: null,
    ...over
  }
}

function fakeStore(defs: AutomationDefinition[], seed: Occurrence[] = []): AutomationStore {
  const definitions = new Map(defs.map((d) => [d.id, d]))
  const occurrences = new Map(seed.map((o) => [o.id, o]))
  return {
    getLoadError: () => null,
    listDefinitions: () => [...definitions.values()],
    getDefinition: (id) => definitions.get(id) ?? null,
    putDefinition: (d) => void definitions.set(d.id, d),
    addRevision: () => {},
    setCurrentRevision: () => {},
    listOccurrences: (automationId) =>
      [...occurrences.values()].filter((o) => !automationId || o.automationId === automationId),
    putOccurrence: (o) => void occurrences.set(o.id, o),
    getOccurrence: (id) => occurrences.get(id) ?? null
  }
}

interface Harness {
  store: AutomationStore
  createRavel: ReturnType<typeof vi.fn>
  wakeTarget: ReturnType<typeof vi.fn>
  timers: { fn: () => void; ms: number }[]
  runtime: ReturnType<typeof createSchedulerRuntime>
}

function harness(defs: AutomationDefinition[], opts: { seed?: Occurrence[]; lastChecked?: number | null; repoPath?: string | null } = {}): Harness {
  const store = fakeStore(defs, opts.seed)
  const createRavel = vi.fn(async (_r: CreateRavelRequest) => ({ ravelId: 'ravel-new' }))
  const wakeTarget = vi.fn(async () => ({}))
  const timers: { fn: () => void; ms: number }[] = []
  let ids = 0
  let ops = 0
  const deps: SchedulerRuntimeDeps = {
    automations: store,
    now: () => NOW,
    makeId: () => `id-${++ids}`,
    makeOperationId: () => `op-${++ops}`,
    loadLastChecked: () => (opts.lastChecked === undefined ? NOW - 2 * MINUTE : opts.lastChecked),
    saveLastChecked: () => {},
    resolveRepoPath: () => (opts.repoPath === undefined ? '/repos/demo' : opts.repoPath),
    defaultHarness: 'claude',
    createRavel,
    wakeTarget,
    setTimer: (fn, ms) => {
      timers.push({ fn, ms })
      return timers.length
    },
    clearTimer: () => {}
  }
  return { store, createRavel, wakeTarget, timers, runtime: createSchedulerRuntime(deps) }
}

describe('scheduler runtime', () => {
  it('fires a due schedule: persists, spawns a Ravel, marks running, arms next wake', async () => {
    const h = harness([definition(revision())])
    await h.runtime.runOnce(NOW)

    expect(h.createRavel).toHaveBeenCalledTimes(1)
    const req = h.createRavel.mock.calls[0][0] as CreateRavelRequest
    expect(req).toMatchObject({ repoId: 'repo-1', repoPath: '/repos/demo', harness: 'claude', initialInstruction: 'do the thing' })

    const running = h.store.listOccurrences().find((o) => o.state === 'running')
    expect(running).toBeTruthy()
    expect(running?.runId).toBe('ravel-new')
    // A timer was armed for the next occurrence.
    expect(h.timers.length).toBe(1)
    expect(h.timers[0].ms).toBeGreaterThan(0)
  })

  it('wakes a heartbeat target and marks the occurrence succeeded', async () => {
    const rev = revision({ kind: 'heartbeat', targetId: 'ravel-42' })
    const h = harness([definition(rev)])
    await h.runtime.runOnce(NOW)

    expect(h.wakeTarget).toHaveBeenCalledWith('ravel-42', 'do the thing')
    expect(h.createRavel).not.toHaveBeenCalled()
    expect(h.store.listOccurrences().some((o) => o.state === 'succeeded')).toBe(true)
  })

  it('skips a schedule whose repo cannot be resolved, without spawning', async () => {
    const h = harness([definition(revision())], { repoPath: null })
    await h.runtime.runOnce(NOW)

    expect(h.createRavel).not.toHaveBeenCalled()
    const occ = h.store.listOccurrences()[0]
    expect(occ.state).toBe('skipped')
    expect(occ.failure?.reason).toBe('repo-not-found')
  })

  it('holds single-flight: a second tick does not spawn while one is running', async () => {
    const h = harness([definition(revision())])
    await h.runtime.runOnce(NOW)
    expect(h.createRavel).toHaveBeenCalledTimes(1)
    await h.runtime.runOnce(NOW + MINUTE)
    expect(h.createRavel).toHaveBeenCalledTimes(1) // still one — active occurrence blocks it
  })

  it('does not arm a timer when nothing is scheduled', async () => {
    const h = harness([])
    await h.runtime.runOnce(NOW)
    expect(h.timers.length).toBe(0)
  })

  it('reconciles a crashed running occurrence to interrupted on start', async () => {
    // Disabled automation so start()'s own tick spawns nothing; only reconcile acts.
    const rev = revision({ enabled: false })
    const h = harness([definition(rev)], { seed: [occurrence({ id: 'occ-crashed', state: 'running', runId: 'ravel-old' })] })
    await h.runtime.start()
    expect(h.store.getOccurrence('occ-crashed')?.state).toBe('interrupted')
    expect(h.createRavel).not.toHaveBeenCalled()
  })

  it('settles a completed run to succeeded', () => {
    const h = harness([definition(revision())], { seed: [occurrence({ id: 'occ-live', state: 'running', runId: 'ravel-live' })] })
    h.runtime.settleRun('ravel-live', true)
    expect(h.store.getOccurrence('occ-live')?.state).toBe('succeeded')
  })
})
