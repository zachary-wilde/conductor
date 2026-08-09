import { describe, expect, it } from 'vitest'
import { isAutomationExhausted, planAutomationTick } from './coordinator'
import type {
  AutomationDefinition,
  AutomationRevision,
  CronSpec,
  Occurrence
} from './types'
import { TERMINAL_OCCURRENCE_STATES } from './types'

// Fixed epoch constants — never Date.now(). All times are arbitrary ms.
// `utc` produces a UTC midnight-aligned instant so `* * * * *` fires once/minute.
const utc = (year: number, month: number, day: number, hour: number, minute: number): number =>
  Date.UTC(year, month - 1, day, hour, minute)

const T00 = utc(2024, 1, 1, 0, 0) // 00:00:00 UTC — exclusive `since` boundary
const T01 = utc(2024, 1, 1, 0, 1) // one fire later
const T02 = utc(2024, 1, 1, 0, 2)
const T03 = utc(2024, 1, 1, 0, 3)

/** Fires every minute on the minute, in UTC. Predictable due-time enumeration. */
const EVERY_MINUTE: CronSpec = { expression: '* * * * *', timezone: 'UTC' }

let revCounter = 0
/** Build an immutable revision; sensible defaults, any field overridable. */
const revision = (over: Partial<AutomationRevision> = {}): AutomationRevision => ({
  id: `rev-${++revCounter}`,
  kind: 'schedule',
  title: 'Test automation',
  enabled: true,
  cadence: EVERY_MINUTE,
  targetId: null,
  prompt: 'do the thing',
  repoId: 'repo-1',
  harness: null,
  model: null,
  ravelRoster: [],
  verificationCommand: null,
  perRunTokenCeiling: null,
  concurrency: 'single-flight',
  stopCondition: { kind: 'until-disabled' },
  approval: { createdBy: 'operator', createdAt: T00, approvedAt: T00 },
  ...over
})

/** Build a definition whose current revision is its first revision. */
const definition = (
  id: string,
  revisions: AutomationRevision[],
  currentRevisionId: string = revisions[0].id
): AutomationDefinition => ({ id, currentRevisionId, revisions })

/** Build an occurrence; sensible defaults, any field overridable. */
const occ = (over: Partial<Occurrence> = {}): Occurrence => ({
  id: 'occ-1',
  automationId: 'auto-1',
  revisionId: 'rev-1',
  state: 'due',
  scheduledAt: T00,
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

/** Deterministic id factories so plans are reproducible across a test. */
const counters = () => {
  let n = 0
  let op = 0
  return {
    makeId: () => `occ-new-${++n}`,
    makeOperationId: () => `op-new-${++op}`
  }
}

describe('isAutomationExhausted', () => {
  describe('max-runs', () => {
    it('is false before the succeeded count reaches `runs`', () => {
      const def = definition('auto-1', [
        revision({ stopCondition: { kind: 'max-runs', runs: 3 } })
      ])
      const occurrences = [
        occ({ automationId: 'auto-1', state: 'succeeded' }),
        occ({ id: 'occ-2', automationId: 'auto-1', state: 'succeeded' })
      ]
      expect(isAutomationExhausted(def, occurrences, T03)).toBe(false)
    })

    it('is true once the succeeded count reaches `runs`', () => {
      const def = definition('auto-1', [
        revision({ stopCondition: { kind: 'max-runs', runs: 2 } })
      ])
      const occurrences = [
        occ({ automationId: 'auto-1', state: 'succeeded' }),
        occ({ id: 'occ-2', automationId: 'auto-1', state: 'succeeded' })
      ]
      expect(isAutomationExhausted(def, occurrences, T03)).toBe(true)
    })

    it('counts only succeeded — failed/skipped/interrupted do not count', () => {
      const def = definition('auto-1', [
        revision({ stopCondition: { kind: 'max-runs', runs: 1 } })
      ])
      // Every non-succeeded terminal state, plus a non-terminal: none count.
      const occurrences = [
        occ({ id: 'a', automationId: 'auto-1', state: 'failed' }),
        occ({ id: 'b', automationId: 'auto-1', state: 'skipped' }),
        occ({ id: 'c', automationId: 'auto-1', state: 'interrupted' }),
        occ({ id: 'd', automationId: 'auto-1', state: 'running' })
      ]
      expect(isAutomationExhausted(def, occurrences, T03)).toBe(false)
    })

    it('ignores succeeded occurrences belonging to other automations', () => {
      const def = definition('auto-1', [
        revision({ stopCondition: { kind: 'max-runs', runs: 1 } })
      ])
      const occurrences = [
        occ({ id: 'x', automationId: 'auto-2', state: 'succeeded' }),
        occ({ id: 'y', automationId: 'auto-2', state: 'succeeded' })
      ]
      expect(isAutomationExhausted(def, occurrences, T03)).toBe(false)
    })
  })

  describe('end-timestamp', () => {
    it('is false strictly before `at`', () => {
      const def = definition('auto-1', [
        revision({ stopCondition: { kind: 'end-timestamp', at: T02 } })
      ])
      expect(isAutomationExhausted(def, [], T01)).toBe(false)
    })

    it('is true at exactly `at` (inclusive boundary)', () => {
      const def = definition('auto-1', [
        revision({ stopCondition: { kind: 'end-timestamp', at: T02 } })
      ])
      expect(isAutomationExhausted(def, [], T02)).toBe(true)
    })

    it('is true after `at`', () => {
      const def = definition('auto-1', [
        revision({ stopCondition: { kind: 'end-timestamp', at: T02 } })
      ])
      expect(isAutomationExhausted(def, [], T03)).toBe(true)
    })
  })

  describe('target-terminal', () => {
    it('is true once any terminal occurrence exists for the automation', () => {
      for (const state of TERMINAL_OCCURRENCE_STATES) {
        const def = definition('auto-1', [revision({ stopCondition: { kind: 'target-terminal' } })])
        const occurrences = [occ({ id: 't', automationId: 'auto-1', state })]
        expect(isAutomationExhausted(def, occurrences, T01)).toBe(true)
      }
    })

    it('is false when only non-terminal occurrences exist', () => {
      const def = definition('auto-1', [revision({ stopCondition: { kind: 'target-terminal' } })])
      const occurrences = [
        occ({ id: 'a', automationId: 'auto-1', state: 'due' }),
        occ({ id: 'b', automationId: 'auto-1', state: 'claimed' }),
        occ({ id: 'c', automationId: 'auto-1', state: 'running' })
      ]
      expect(isAutomationExhausted(def, occurrences, T01)).toBe(false)
    })

    it('ignores terminal occurrences of other automations', () => {
      const def = definition('auto-1', [revision({ stopCondition: { kind: 'target-terminal' } })])
      const occurrences = [occ({ id: 'x', automationId: 'auto-2', state: 'succeeded' })]
      expect(isAutomationExhausted(def, occurrences, T01)).toBe(false)
    })
  })

  describe('until-disabled', () => {
    it('is never exhausted regardless of occurrence history', () => {
      const def = definition('auto-1', [revision({ stopCondition: { kind: 'until-disabled' } })])
      const occurrences = Array.from({ length: 50 }, (_, i) =>
        occ({ id: `s-${i}`, automationId: 'auto-1', state: 'succeeded' })
      )
      expect(isAutomationExhausted(def, occurrences, T03)).toBe(false)
    })
  })

  it('reads the stop condition of the CURRENT revision, not historical ones', () => {
    const old = revision({ stopCondition: { kind: 'max-runs', runs: 1 } })
    const current = revision({ stopCondition: { kind: 'until-disabled' } })
    const def = definition('auto-1', [old, current], current.id)
    const occurrences = [occ({ automationId: 'auto-1', state: 'succeeded' })]
    // Old revision would be exhausted at runs=1; current (until-disabled) is not.
    expect(isAutomationExhausted(def, occurrences, T03)).toBe(false)
  })
})

describe('planAutomationTick', () => {
  it('skips automations whose current revision is disabled', () => {
    const def = definition('auto-1', [revision({ enabled: false })])
    const plan = planAutomationTick({
      definitions: [def],
      occurrences: [],
      lastCheckedAt: T00,
      now: T03,
      ...counters()
    })
    expect(plan.upserts).toHaveLength(0)
    expect(plan.spawnable).toHaveLength(0)
  })

  it('skips exhausted automations even when their cadence is due', () => {
    const def = definition('auto-1', [
      revision({ stopCondition: { kind: 'max-runs', runs: 1 } })
    ])
    const occurrences = [occ({ automationId: 'auto-1', state: 'succeeded' })]
    const plan = planAutomationTick({
      definitions: [def],
      occurrences,
      lastCheckedAt: T00,
      now: T03,
      ...counters()
    })
    expect(plan.upserts).toHaveLength(0)
    expect(plan.spawnable).toHaveLength(0)
  })

  it('returns an empty plan when nothing is due in the window', () => {
    const def = definition('auto-1', [revision()])
    const plan = planAutomationTick({
      definitions: [def],
      occurrences: [],
      lastCheckedAt: T00,
      now: T00, // empty window
      ...counters()
    })
    expect(plan.upserts).toHaveLength(0)
    expect(plan.spawnable).toHaveLength(0)
  })

  it('a fresh due time with no active occurrence yields one new due occurrence in both upserts and spawnable', () => {
    const rev = revision()
    const def = definition('auto-1', [rev])
    const c = counters()
    const plan = planAutomationTick({
      definitions: [def],
      occurrences: [],
      lastCheckedAt: T00,
      now: T01, // exactly one fire at T01
      ...c
    })

    expect(plan.upserts).toHaveLength(1)
    expect(plan.spawnable).toHaveLength(1)

    const created = plan.upserts[0]
    expect(created.id).toBe('occ-new-1')
    expect(created.state).toBe('due')
    expect(created.automationId).toBe('auto-1')
    expect(created.revisionId).toBe(rev.id)
    expect(created.scheduledAt).toBe(T01)
    expect(created.isCatchUp).toBe(false)
    expect(created.missedCount).toBe(0)
    expect(created.operationId).toBe('op-new-1')

    expect(plan.spawnable[0].occurrence).toBe(created)
    expect(plan.spawnable[0].revision).toBe(rev)
  })

  it('multiple due times with an existing active occurrence fold into it (not spawnable, exactly one upsert)', () => {
    const rev = revision()
    const def = definition('auto-1', [rev])
    const active = occ({
      id: 'running-1',
      automationId: 'auto-1',
      revisionId: rev.id,
      state: 'running',
      scheduledAt: T00,
      missedCount: 0
    })
    const plan = planAutomationTick({
      definitions: [def],
      occurrences: [active],
      lastCheckedAt: T00,
      now: T03, // fires at T01, T02, T03 — three due times
      ...counters()
    })

    // Exactly one upsert for this automation, and it is the folded active one.
    expect(plan.upserts).toHaveLength(1)
    expect(plan.upserts[0].id).toBe('running-1')
    expect(plan.upserts[0].missedCount).toBe(3) // bumped by dueTimes.length
    expect(plan.upserts[0].state).toBe('running') // state preserved

    // An active sibling already exists -> nothing is clear to launch.
    expect(plan.spawnable).toHaveLength(0)
  })

  it('folds into a pending (due) active occurrence as well as a running one', () => {
    const rev = revision()
    const def = definition('auto-1', [rev])
    const active = occ({
      id: 'pending-1',
      automationId: 'auto-1',
      revisionId: rev.id,
      state: 'due',
      missedCount: 2
    })
    const plan = planAutomationTick({
      definitions: [def],
      occurrences: [active],
      lastCheckedAt: T00,
      now: T02, // fires at T01, T02
      ...counters()
    })
    expect(plan.upserts).toHaveLength(1)
    expect(plan.upserts[0].id).toBe('pending-1')
    expect(plan.upserts[0].missedCount).toBe(4) // 2 + 2 folded
    expect(plan.spawnable).toHaveLength(0)
  })

  it('a catch-up (no active + multiple due) is flagged isCatchUp with correct missedCount', () => {
    const rev = revision()
    const def = definition('auto-1', [rev])
    const plan = planAutomationTick({
      definitions: [def],
      occurrences: [],
      lastCheckedAt: T00,
      now: T03, // fires at T01, T02, T03 — three missed
      ...counters()
    })

    expect(plan.upserts).toHaveLength(1)
    const catchUp = plan.upserts[0]
    expect(catchUp.isCatchUp).toBe(true)
    expect(catchUp.missedCount).toBe(2) // 3 due - 1 represented = 2 missed
    expect(catchUp.scheduledAt).toBe(T01) // earliest of the missed times
    expect(catchUp.state).toBe('due')

    // No active sibling -> clear to launch.
    expect(plan.spawnable).toHaveLength(1)
    expect(plan.spawnable[0].occurrence).toBe(catchUp)
  })

  it('a terminal-only history (no active occurrence) still allows a fresh spawn', () => {
    const rev = revision({ stopCondition: { kind: 'until-disabled' } })
    const def = definition('auto-1', [rev])
    // A previously succeeded occurrence is terminal, so there is no active one.
    const occurrences = [
      occ({ id: 'done-1', automationId: 'auto-1', state: 'succeeded' })
    ]
    const plan = planAutomationTick({
      definitions: [def],
      occurrences,
      lastCheckedAt: T00,
      now: T01,
      ...counters()
    })
    expect(plan.upserts).toHaveLength(1)
    expect(plan.upserts[0].id).toBe('occ-new-1') // brand new occurrence
    expect(plan.spawnable).toHaveLength(1)
  })

  it('plans multiple automations independently', () => {
    const revA = revision()
    const revB = revision()
    const defA = definition('auto-1', [revA])
    const defB = definition('auto-2', [revB])
    const disabled = definition('auto-3', [revision({ enabled: false })])
    const plan = planAutomationTick({
      definitions: [defA, defB, disabled],
      occurrences: [],
      lastCheckedAt: T00,
      now: T01,
      ...counters()
    })

    expect(plan.upserts).toHaveLength(2)
    expect(plan.upserts.map((o) => o.automationId).sort()).toEqual(['auto-1', 'auto-2'])
    expect(plan.spawnable).toHaveLength(2)
    expect(plan.spawnable.map((s) => s.occurrence.automationId).sort()).toEqual([
      'auto-1',
      'auto-2'
    ])
  })

  it('calls makeOperationId once per due automation and makeId once per new occurrence', () => {
    const def = definition('auto-1', [revision()])
    let ids = 0
    let ops = 0
    planAutomationTick({
      definitions: [def],
      occurrences: [],
      lastCheckedAt: T00,
      now: T03, // catch-up: 3 due -> 1 new occurrence
      makeId: () => `id-${++ids}`,
      makeOperationId: () => `op-${++ops}`
    })
    expect(ids).toBe(1)
    expect(ops).toBe(1)
  })

  it('does not call makeOperationId for an automation with no due times', () => {
    const def = definition('auto-1', [revision()])
    let ops = 0
    const plan = planAutomationTick({
      definitions: [def],
      occurrences: [],
      lastCheckedAt: T00,
      now: T00, // empty window
      makeId: () => 'should-not-happen',
      makeOperationId: () => `op-${++ops}`
    })
    expect(ops).toBe(0)
    expect(plan.upserts).toHaveLength(0)
  })
})
