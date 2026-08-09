import { describe, expect, it } from 'vitest'
import {
  availableControls,
  detachAffectsDependents,
  requiresConfirmation
} from './worker-controls'
import type { WorkerControlAction, WorkerControlState } from './worker-controls'
import type { WorkerKind } from './events'

/**
 * Build a control-plane state with sensible defaults; any field overridable.
 * Defaults describe an unremarkable running session with no parent and no
 * dependents, so individual cases override only the axis they exercise.
 */
const state = (over: Partial<WorkerControlState> = {}): WorkerControlState => ({
  kind: 'session',
  lifecycle: 'running',
  responseInFlight: false,
  hasParentRavel: false,
  dependentCount: 0,
  ...over
})

/** Every worker shape the controls logic discriminates on. */
const EVERY_KIND: readonly WorkerKind[] = [
  'ravel-manager',
  'ravel-child',
  'roundtable-seat',
  'session'
]

describe('availableControls', () => {
  describe('capability per lifecycle (session, no parent, no dependents)', () => {
    // Exact arrays the spec pins. A plain session is never detachable, so these
    // isolate the lifecycle-driven controls (message / pause / resume / stop /
    // retry / archive) from the kind-driven `detach`.
    const cases: ReadonlyArray<{ lifecycle: WorkerControlState['lifecycle']; expected: WorkerControlAction[] }> = [
      { lifecycle: 'starting', expected: ['message', 'stop'] },
      { lifecycle: 'running', expected: ['message', 'pause', 'stop'] },
      { lifecycle: 'pause-requested', expected: ['message', 'resume', 'stop'] },
      { lifecycle: 'paused', expected: ['message', 'resume', 'stop'] },
      { lifecycle: 'terminal', expected: ['retry', 'archive'] }
    ]

    it.each(cases)('lifecycle $lifecycle -> $expected', ({ lifecycle, expected }) => {
      expect(availableControls(state({ lifecycle }))).toEqual(expected)
    })

    it('a running session offers message/pause/stop and nothing else', () => {
      expect(availableControls(state({ kind: 'session', lifecycle: 'running' }))).toEqual([
        'message',
        'pause',
        'stop'
      ])
    })

    it('a paused worker offers resume but not pause', () => {
      const controls = availableControls(state({ lifecycle: 'paused' }))
      expect(controls).toContain('resume')
      expect(controls).not.toContain('pause')
    })

    it('pause is absent while pause-requested (only resume can cancel it)', () => {
      const controls = availableControls(state({ lifecycle: 'pause-requested' }))
      expect(controls).not.toContain('pause')
      expect(controls).toContain('resume')
    })

    it('a terminal worker offers EXACTLY retry and archive', () => {
      expect(availableControls(state({ lifecycle: 'terminal' }))).toEqual(['retry', 'archive'])
    })

    it('a terminal worker offers no message / pause / resume / stop / detach', () => {
      const controls = availableControls(state({ kind: 'ravel-child', lifecycle: 'terminal', hasParentRavel: true }))
      expect(controls).toEqual(['retry', 'archive'])
      expect(controls).not.toEqual(
        expect.arrayContaining(['message', 'pause', 'resume', 'stop', 'detach'])
      )
    })
  })

  describe('detach eligibility', () => {
    it('detach appears only for a non-terminal ravel-child with a parent ravel', () => {
      expect(availableControls(state({ kind: 'ravel-child', lifecycle: 'running', hasParentRavel: true }))).toEqual([
        'message',
        'pause',
        'stop',
        'detach'
      ])
    })

    it.each(EVERY_KIND.filter((k) => k !== 'ravel-child'))(
      'detach is NEVER available for a %s, even with a parent ravel',
      (kind) => {
        const controls = availableControls(state({ kind, lifecycle: 'running', hasParentRavel: true }))
        expect(controls).not.toContain('detach')
      }
    )

    it('a ravel-child without a parent ravel cannot detach', () => {
      expect(availableControls(state({ kind: 'ravel-child', lifecycle: 'running', hasParentRavel: false }))).not.toContain(
        'detach'
      )
    })

    it('a terminal ravel-child cannot detach, even with a parent', () => {
      expect(
        availableControls(state({ kind: 'ravel-child', lifecycle: 'terminal', hasParentRavel: true }))
      ).toEqual(['retry', 'archive'])
    })

    it('detach remains available to a paused and a pause-requested ravel-child (still non-terminal)', () => {
      expect(
        availableControls(state({ kind: 'ravel-child', lifecycle: 'paused', hasParentRavel: true }))
      ).toContain('detach')
      expect(
        availableControls(
          state({ kind: 'ravel-child', lifecycle: 'pause-requested', hasParentRavel: true })
        )
      ).toContain('detach')
    })

    it('detach placement is stable (after stop, before nothing else)', () => {
      expect(availableControls(state({ kind: 'ravel-child', lifecycle: 'running', hasParentRavel: true }))).toEqual([
        'message',
        'pause',
        'stop',
        'detach'
      ])
    })
  })

  describe('result is a stable, canonical order regardless of lifecycle', () => {
    // The canonical action order is the single source of truth. Filtering it to
    // the actions actually present yields the expected result: it enforces the
    // order, proves there are no duplicates (each canonical action appears at
    // most once), and proves there are no unexpected actions (everything in the
    // result is in the canonical universe).
    const canonical: readonly WorkerControlAction[] = [
      'message',
      'pause',
      'resume',
      'stop',
      'retry',
      'archive',
      'detach'
    ]

    it.each([
      ['starting', 'session'],
      ['running', 'session'],
      ['pause-requested', 'session'],
      ['paused', 'session'],
      ['terminal', 'session'],
      ['running', 'ravel-child'],
      ['paused', 'ravel-child'],
      ['terminal', 'ravel-child']
    ] as const)('lifecycle=%s kind=%s matches the canonical projection', (lifecycle, kind) => {
      const controls = availableControls(state({ lifecycle, kind, hasParentRavel: kind === 'ravel-child' }))
      const projected = canonical.filter((a) => controls.includes(a))
      expect(controls).toEqual(projected)
    })
  })

  describe('responseInFlight is reserved and never changes availability', () => {
    it.each([true, false])('responseInFlight=%s yields identical controls', (responseInFlight) => {
      const base = state({ kind: 'ravel-child', lifecycle: 'running', hasParentRavel: true })
      expect(availableControls({ ...base, responseInFlight })).toEqual(availableControls(base))
    })
  })

  describe('dependentCount never gates availability', () => {
    it.each([0, 1, 7])('a running ravel-child with %i dependents still offers the same controls', (n) => {
      expect(
        availableControls(state({ kind: 'ravel-child', lifecycle: 'running', hasParentRavel: true, dependentCount: n }))
      ).toEqual(['message', 'pause', 'stop', 'detach'])
    })
  })
})

describe('requiresConfirmation', () => {
  // The rule is action-driven. The sample state is a running ravel-child; the
  // per-action expectation must hold for ANY state, asserted separately below.
  const sample = state({ kind: 'ravel-child', lifecycle: 'running', hasParentRavel: true })

  const cases: ReadonlyArray<{ action: WorkerControlAction; expected: boolean }> = [
    { action: 'message', expected: false },
    { action: 'pause', expected: false },
    { action: 'resume', expected: false },
    { action: 'stop', expected: true },
    { action: 'retry', expected: false },
    { action: 'archive', expected: true },
    { action: 'detach', expected: true }
  ]

  it.each(cases)('action $action -> confirm=$expected', ({ action, expected }) => {
    expect(requiresConfirmation(action, sample)).toBe(expected)
  })

  it('only stop, detach, and archive require confirmation (the destructive trio)', () => {
    const all: WorkerControlAction[] = [
      'message',
      'pause',
      'resume',
      'stop',
      'retry',
      'archive',
      'detach'
    ]
    const confirming = all.filter((a) => requiresConfirmation(a, sample))
    expect(confirming).toEqual(['stop', 'archive', 'detach'])
  })

  it('is independent of state: archive confirms even for a non-terminal worker', () => {
    // The UI computes confirmation from the action alone, before availability
    // has narrowed it, so the answer must not depend on lifecycle/kind.
    expect(
      requiresConfirmation('archive', state({ kind: 'session', lifecycle: 'running' }))
    ).toBe(true)
    expect(
      requiresConfirmation('message', state({ kind: 'session', lifecycle: 'terminal' }))
    ).toBe(false)
    expect(
      requiresConfirmation('stop', state({ kind: 'ravel-child', lifecycle: 'starting', hasParentRavel: false }))
    ).toBe(true)
  })
})

describe('detachAffectsDependents', () => {
  const cases: ReadonlyArray<{
    name: string
    state: WorkerControlState
    expected: boolean
  }> = [
    {
      name: 'detachable ravel-child with no dependents -> false',
      state: state({ kind: 'ravel-child', lifecycle: 'running', hasParentRavel: true, dependentCount: 0 }),
      expected: false
    },
    {
      name: 'detachable ravel-child with dependents -> true',
      state: state({ kind: 'ravel-child', lifecycle: 'running', hasParentRavel: true, dependentCount: 3 }),
      expected: true
    },
    {
      name: 'ravel-child with dependents but no parent ravel -> false (not detachable)',
      state: state({ kind: 'ravel-child', lifecycle: 'running', hasParentRavel: false, dependentCount: 3 }),
      expected: false
    },
    {
      name: 'terminal ravel-child with dependents -> false (detach no longer applies)',
      state: state({ kind: 'ravel-child', lifecycle: 'terminal', hasParentRavel: true, dependentCount: 3 }),
      expected: false
    },
    {
      name: 'session with dependents -> false (sessions are never detachable)',
      state: state({ kind: 'session', lifecycle: 'running', hasParentRavel: true, dependentCount: 3 }),
      expected: false
    },
    {
      name: 'ravel-manager with dependents -> false',
      state: state({ kind: 'ravel-manager', lifecycle: 'running', hasParentRavel: true, dependentCount: 3 }),
      expected: false
    },
    {
      name: 'roundtable-seat with dependents -> false',
      state: state({ kind: 'roundtable-seat', lifecycle: 'running', hasParentRavel: true, dependentCount: 3 }),
      expected: false
    },
    {
      name: 'paused ravel-child with dependents -> true (paused is still non-terminal)',
      state: state({ kind: 'ravel-child', lifecycle: 'paused', hasParentRavel: true, dependentCount: 2 }),
      expected: true
    },
    {
      name: 'pause-requested ravel-child with a dependent -> true',
      state: state({ kind: 'ravel-child', lifecycle: 'pause-requested', hasParentRavel: true, dependentCount: 1 }),
      expected: true
    }
  ]

  it.each(cases)('$name', ({ state: s, expected }) => {
    expect(detachAffectsDependents(s)).toBe(expected)
  })

  it('is true only when dependentCount > 0', () => {
    // Across every worker shape and the live lifecycles, a zero dependent
    // count never reports affected dependents, and a positive count does only
    // for a detachable ravel-child.
    for (const kind of EVERY_KIND) {
      for (const lifecycle of ['starting', 'running', 'pause-requested', 'paused'] as const) {
        const zero = detachAffectsDependents(
          state({ kind, lifecycle, hasParentRavel: true, dependentCount: 0 })
        )
        expect(zero).toBe(false)
        const positive = detachAffectsDependents(
          state({ kind, lifecycle, hasParentRavel: true, dependentCount: 5 })
        )
        expect(positive).toBe(kind === 'ravel-child')
      }
    }
  })
})
