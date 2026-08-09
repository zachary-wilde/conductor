import { describe, expect, it } from 'vitest'
import {
  applyTransition,
  canTransition,
  coalesceDue,
  registerOperation,
  reconcileOnRestart
} from './occurrence-ledger'
import type { Occurrence, OccurrenceState } from './types'
import { TERMINAL_OCCURRENCE_STATES } from './types'

// Fixed epoch constants — never Date.now(). All times here are arbitrary ms.
const T0 = 1_700_000_000_000
const T1 = T0 + 60_000
const T2 = T0 + 120_000
const T3 = T0 + 180_000
const T4 = T0 + 240_000

const ALL_STATES: OccurrenceState[] = [
  'due',
  'claimed',
  'running',
  'succeeded',
  'failed',
  'skipped',
  'interrupted'
]

const occ = (over: Partial<Occurrence> = {}): Occurrence => ({
  id: 'occ-1',
  automationId: 'auto-1',
  revisionId: 'rev-1',
  state: 'due',
  scheduledAt: T0,
  startedAt: null,
  endedAt: null,
  isCatchUp: false,
  missedCount: 0,
  runId: null,
  operationId: 'op-1',
  failure: null,
  tokensUsed: null,
  ...over
})

const opts = (over: { operationId?: string; makeId?: () => string; isCatchUp?: boolean } = {}) => ({
  automationId: 'auto-1',
  revisionId: 'rev-1',
  operationId: 'op-new',
  makeId: () => 'occ-new',
  isCatchUp: true,
  ...over
})

describe('canTransition', () => {
  it('allows exactly the documented forward edges', () => {
    const legal: Array<[OccurrenceState, OccurrenceState]> = [
      ['due', 'claimed'],
      ['due', 'skipped'],
      ['claimed', 'running'],
      ['claimed', 'skipped'],
      ['running', 'succeeded'],
      ['running', 'failed'],
      ['running', 'interrupted']
    ]
    for (const [from, to] of legal) {
      expect(canTransition(from, to)).toBe(true)
    }
  })

  it('rejects every other ordered pair of states', () => {
    for (const from of ALL_STATES) {
      for (const to of ALL_STATES) {
        const documented =
          (from === 'due' && (to === 'claimed' || to === 'skipped')) ||
          (from === 'claimed' && (to === 'running' || to === 'skipped')) ||
          (from === 'running' && (to === 'succeeded' || to === 'failed' || to === 'interrupted'))
        expect(canTransition(from, to)).toBe(documented)
      }
    }
  })

  it('rejects transitions out of every terminal state', () => {
    for (const terminal of TERMINAL_OCCURRENCE_STATES) {
      for (const to of ALL_STATES) {
        expect(canTransition(terminal, to)).toBe(false)
      }
    }
  })

  it('rejects skipping claimed: no due→running edge, and no self-transitions', () => {
    expect(canTransition('due', 'running')).toBe(false)
    for (const s of ALL_STATES) {
      expect(canTransition(s, s)).toBe(false)
    }
  })
})

describe('applyTransition', () => {
  it('throws on every illegal edge', () => {
    for (const from of ALL_STATES) {
      for (const to of ALL_STATES) {
        if (!canTransition(from, to)) {
          expect(() => applyTransition(occ({ state: from }), to, T1)).toThrow()
        }
      }
    }
  })

  it('returns a new object and never mutates the input', () => {
    const before = occ({ state: 'due' })
    const snapshot = { ...before }
    const after = applyTransition(before, 'claimed', T1)

    expect(after).not.toBe(before)
    expect(before).toEqual(snapshot) // input untouched
  })

  it('stamps startedAt on →running and carries nothing before then', () => {
    const claimed = occ({ state: 'claimed' })
    const running = applyTransition(claimed, 'running', T2)
    expect(running.state).toBe('running')
    expect(running.startedAt).toBe(T2)
    expect(running.endedAt).toBe(null)
  })

  it('does not stamp startedAt before running (claimed keeps startedAt null)', () => {
    const due = occ({ state: 'due' })
    const claimed = applyTransition(due, 'claimed', T1)
    expect(claimed.startedAt).toBe(null)
  })

  it('stamps endedAt on every terminal transition', () => {
    const running = occ({ state: 'running', startedAt: T1 })
    for (const terminal of ['succeeded', 'failed', 'interrupted'] as const) {
      const out = applyTransition(running, terminal, T2)
      expect(out.state).toBe(terminal)
      expect(out.endedAt).toBe(T2)
    }
    // skipped is terminal too and can be reached straight from due.
    const skipped = applyTransition(occ({ state: 'due' }), 'skipped', T1)
    expect(skipped.endedAt).toBe(T1)
  })

  it('keeps startedAt once set across the terminal transition', () => {
    const running = occ({ state: 'running', startedAt: T1 })
    const succeeded = applyTransition(running, 'succeeded', T2)
    expect(succeeded.startedAt).toBe(T1)
    expect(succeeded.endedAt).toBe(T2)
  })

  it('applies the patch fields (runId, failure, tokensUsed)', () => {
    const claimed = occ({ state: 'claimed' })
    const running = applyTransition(claimed, 'running', T1, { runId: 'run-9' })
    expect(running.runId).toBe('run-9')

    const ok = occ({ state: 'running', startedAt: T1 })
    const succeeded = applyTransition(ok, 'succeeded', T2, {
      runId: 'run-9',
      tokensUsed: 1234,
      failure: null
    })
    expect(succeeded.tokensUsed).toBe(1234)
    expect(succeeded.failure).toBe(null)
  })

  it('does not overwrite endedAt/startedAt when patch omits them', () => {
    const running = occ({ state: 'running', startedAt: T1 })
    const failed = applyTransition(running, 'failed', T2, {
      failure: { reason: 'agent-error', detail: 'crashed' }
    })
    expect(failed.startedAt).toBe(T1)
    expect(failed.endedAt).toBe(T2)
    expect(failed.failure).toEqual({ reason: 'agent-error', detail: 'crashed' })
  })
})

describe('coalesceDue', () => {
  it('returns none with no occurrence when dueTimes is empty', () => {
    expect(coalesceDue(null, [], opts())).toEqual({ occurrence: null, coalescedInto: 'none' })
    // Even if an active occurrence exists, an empty due list yields none.
    const active = occ({ state: 'running' })
    expect(coalesceDue(active, [], opts())).toEqual({
      occurrence: null,
      coalescedInto: 'none'
    })
  })

  it('folds due times into a non-terminal active occurrence (single-flight)', () => {
    const active = occ({ state: 'running', startedAt: T1, missedCount: 2 })
    let makeCalls = 0
    const result = coalesceDue(active, [T1, T2, T3], opts({ makeId: () => (makeCalls++, 'x') }))

    expect(result.coalescedInto).toBe('existing')
    expect(makeCalls).toBe(0) // never mints a new id while folding
    expect(result.occurrence).not.toBe(active) // new object
    expect(result.occurrence?.missedCount).toBe(5) // 2 + 3
    expect(result.occurrence?.state).toBe('running') // state untouched
    expect(active.missedCount).toBe(2) // input untouched
  })

  it('folds the same way for a due or claimed active occurrence', () => {
    for (const state of ['due', 'claimed'] as const) {
      const active = occ({ state, missedCount: 0 })
      const result = coalesceDue(active, [T1], opts())
      expect(result.coalescedInto).toBe('existing')
      expect(result.occurrence?.missedCount).toBe(1)
    }
  })

  it('creates exactly one catch-up occurrence from multiple due times', () => {
    const result = coalesceDue(null, [T2, T0, T3, T1], opts())

    expect(result.coalescedInto).toBe('new')
    const created = result.occurrence
    expect(created).not.toBeNull()
    expect(created).toEqual(
      occ({
        id: 'occ-new',
        automationId: 'auto-1',
        revisionId: 'rev-1',
        state: 'due',
        scheduledAt: T0, // earliest of the four
        startedAt: null,
        endedAt: null,
        isCatchUp: true,
        missedCount: 3, // four due times minus the one it represents
        runId: null,
        operationId: 'op-new',
        failure: null,
        tokensUsed: null
      })
    )
  })

  it('creates a single due occurrence when exactly one time is due (missedCount 0)', () => {
    const result = coalesceDue(null, [T1], opts())
    expect(result.coalescedInto).toBe('new')
    expect(result.occurrence?.scheduledAt).toBe(T1)
    expect(result.occurrence?.missedCount).toBe(0)
    expect(result.occurrence?.isCatchUp).toBe(true)
  })

  it('creates a new occurrence when the active occurrence is terminal', () => {
    const terminal = occ({ state: 'succeeded', endedAt: T1 })
    const result = coalesceDue(terminal, [T2, T3], opts())
    expect(result.coalescedInto).toBe('new')
    expect(result.occurrence?.state).toBe('due')
    expect(result.occurrence?.scheduledAt).toBe(T2)
    expect(result.occurrence?.missedCount).toBe(1)
  })

  it('honours operationId, isCatchUp, and makeId from opts on the new path', () => {
    let calls = 0
    const result = coalesceDue(null, [T1], opts({
      operationId: 'op-99',
      makeId: () => (calls++, 'minted-id'),
      isCatchUp: false
    }))
    expect(calls).toBe(1)
    expect(result.occurrence?.id).toBe('minted-id')
    expect(result.occurrence?.operationId).toBe('op-99')
    expect(result.occurrence?.isCatchUp).toBe(false)
  })

  it('keeps new occurrences free of stale run/failure/token state', () => {
    const result = coalesceDue(null, [T1], opts())
    expect(result.occurrence?.runId).toBeNull()
    expect(result.occurrence?.failure).toBeNull()
    expect(result.occurrence?.tokensUsed).toBeNull()
    expect(result.occurrence?.startedAt).toBeNull()
    expect(result.occurrence?.endedAt).toBeNull()
  })
})

describe('registerOperation', () => {
  it('runs compute once, stores, and returns the result', () => {
    const registry = new Map<string, number>()
    let calls = 0
    const r = registerOperation(registry, 'op-1', () => (calls++, 42))
    expect(r).toBe(42)
    expect(calls).toBe(1)
    expect(registry.get('op-1')).toBe(42)
  })

  it('returns the stored result WITHOUT re-running compute on a repeated id', () => {
    const registry = new Map<string, string>()
    let calls = 0
    const compute = () => (calls++, `run-${calls}`)
    const first = registerOperation(registry, 'op-1', compute)
    const second = registerOperation(registry, 'op-1', compute)
    expect(first).toBe('run-1')
    expect(second).toBe('run-1') // identical to the first, not recomputed
    expect(calls).toBe(1)
  })

  it('distinguishes ids: different operationIds run independently', () => {
    const registry = new Map<string, number>()
    let calls = 0
    const a = registerOperation(registry, 'op-a', () => (calls++, 1))
    const b = registerOperation(registry, 'op-b', () => (calls++, 2))
    expect(a).toBe(1)
    expect(b).toBe(2)
    expect(calls).toBe(2)
    expect(registry.size).toBe(2)
  })

  it('preserves the stored value object identity across repeats', () => {
    const registry = new Map<string, { ok: boolean }>()
    const ref = { ok: true }
    const first = registerOperation(registry, 'op-1', () => ref)
    const second = registerOperation(registry, 'op-1', () => ({ ok: false }))
    expect(second).toBe(first)
    expect(second).toBe(ref)
  })
})

describe('reconcileOnRestart', () => {
  it('turns claimed and running occurrences into interrupted', () => {
    const input: Occurrence[] = [
      occ({ id: 'a', state: 'claimed' }),
      occ({ id: 'b', state: 'running', startedAt: T1 })
    ]
    const out = reconcileOnRestart(input, T4)

    expect(out).toHaveLength(2)
    expect(out[0]).toEqual(
      occ({ id: 'a', state: 'interrupted', endedAt: T4, failure: { reason: 'core-restart' } })
    )
    // startedAt from the running occurrence is preserved.
    expect(out[1]).toEqual(
      occ({
        id: 'b',
        state: 'interrupted',
        startedAt: T1,
        endedAt: T4,
        failure: { reason: 'core-restart' }
      })
    )
  })

  it('leaves due and terminal occurrences untouched', () => {
    const due = occ({ id: 'due-1', state: 'due' })
    const succeeded = occ({ id: 'ok-1', state: 'succeeded', startedAt: T1, endedAt: T2 })
    const failed = occ({
      id: 'bad-1',
      state: 'failed',
      endedAt: T2,
      failure: { reason: 'agent-error' }
    })
    const out = reconcileOnRestart([due, succeeded, failed], T4)
    expect(out[0]).toBe(due)
    expect(out[1]).toBe(succeeded)
    expect(out[2]).toBe(failed)
  })

  it('never promotes an unknown outcome to succeeded', () => {
    const running = occ({ id: 'r', state: 'running', startedAt: T1 })
    const out = reconcileOnRestart([running], T4)
    expect(out[0].state).toBe('interrupted')
    expect(out[0].state).not.toBe('succeeded')
  })

  it('returns a new array and does not mutate the input', () => {
    const input = [occ({ id: 'r', state: 'running' })]
    const snapshot = input.map((o) => ({ ...o }))
    const out = reconcileOnRestart(input, T4)
    expect(out).not.toBe(input)
    expect(input).toEqual(snapshot)
  })
})
