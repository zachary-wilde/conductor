import { describe, expect, it } from 'vitest'
import { nextWakeAt, planSchedulerTick } from './scheduler'
import type {
  AutomationDefinition,
  AutomationRevision,
  CronSpec,
  Occurrence
} from './types'

// Fixed epoch constants — never Date.now(). All times are arbitrary ms.
// `utc` produces a UTC midnight-aligned instant so `* * * * *` fires once/minute.
const utc = (year: number, month: number, day: number, hour: number, minute: number): number =>
  Date.UTC(year, month - 1, day, hour, minute)

const T00 = utc(2024, 1, 1, 0, 0) // 00:00:00 UTC — exclusive boundary
const T01 = utc(2024, 1, 1, 0, 1)
const T02 = utc(2024, 1, 1, 0, 2)
const T03 = utc(2024, 1, 1, 0, 3)

/** Fires every minute on the minute, in UTC. Predictable due-time enumeration. */
const EVERY_MINUTE: CronSpec = { expression: '* * * * *', timezone: 'UTC' }
/** Fires at minute 5 of each hour, in UTC. */
const AT_FIVE: CronSpec = { expression: '5 * * * *', timezone: 'UTC' }

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

describe('nextWakeAt', () => {
  it('returns the earliest future fire across two enabled automations', () => {
    const frequent = definition('auto-a', [revision({ cadence: EVERY_MINUTE })]) // fires T01
    const sparse = definition('auto-b', [revision({ cadence: AT_FIVE })]) // fires T05

    expect(nextWakeAt([frequent, sparse], [], T00)).toBe(T01)
    // order-independent — it is a min, not a first-match
    expect(nextWakeAt([sparse, frequent], [], T00)).toBe(T01)
  })

  it('is strictly after `after`', () => {
    const def = definition('auto-1', [revision({ cadence: EVERY_MINUTE })])
    expect(nextWakeAt([def], [], T01)).toBe(T02)
  })

  it('skips a disabled automation and an exhausted one, returning the next enabled fire', () => {
    const disabled = definition('auto-a', [revision({ enabled: false })])
    const exhausted = definition('auto-b', [
      revision({ stopCondition: { kind: 'max-runs', runs: 1 } })
    ])
    const enabled = definition('auto-c', [revision({ cadence: EVERY_MINUTE })]) // fires T01
    const occurrences = [occ({ automationId: 'auto-b', state: 'succeeded' })] // exhausts b

    expect(nextWakeAt([disabled, exhausted, enabled], occurrences, T00)).toBe(T01)
  })

  it('returns null when every automation is disabled', () => {
    const a = definition('auto-a', [revision({ enabled: false })])
    const b = definition('auto-b', [revision({ enabled: false })])
    expect(nextWakeAt([a, b], [], T00)).toBeNull()
  })

  it('returns null when the only automation is exhausted', () => {
    const def = definition('auto-1', [
      revision({ stopCondition: { kind: 'max-runs', runs: 1 } })
    ])
    const occurrences = [occ({ automationId: 'auto-1', state: 'succeeded' })]
    expect(nextWakeAt([def], occurrences, T00)).toBeNull()
  })

  it('skips a definition whose current revision is missing', () => {
    const rev = revision({ cadence: EVERY_MINUTE })
    const def = definition('auto-1', [rev], 'missing-rev-id')
    expect(nextWakeAt([def], [], T00)).toBeNull()
  })

  it('returns null for an empty definition list', () => {
    expect(nextWakeAt([], [], T00)).toBeNull()
  })
})

describe('planSchedulerTick', () => {
  it('surfaces planAutomationTick upserts+spawnable and a non-null nextWakeAt', () => {
    const rev = revision()
    const def = definition('auto-1', [rev])
    const tick = planSchedulerTick({
      definitions: [def],
      occurrences: [],
      lastCheckedAt: T00,
      now: T01, // exactly one fire at T01 -> a fresh due occurrence
      ...counters()
    })

    expect(tick.upserts).toHaveLength(1)
    expect(tick.spawnable).toHaveLength(1)
    expect(tick.spawnable[0].occurrence).toBe(tick.upserts[0])
    expect(tick.spawnable[0].revision).toBe(rev)
    // Next fire strictly after now=T01 for an every-minute cadence is T02.
    expect(tick.nextWakeAt).toBe(T02)
  })

  it('computes nextWakeAt against the post-tick occurrence view (upserts folded in)', () => {
    const rev = revision()
    const def = definition('auto-1', [rev])
    const existing = occ({ id: 'pre', automationId: 'auto-1', state: 'running' })
    const tick = planSchedulerTick({
      definitions: [def],
      occurrences: [existing],
      lastCheckedAt: T00,
      now: T03, // folds T01/T02/T03 into the running occurrence; no new spawn
      ...counters()
    })

    // Folded into the existing running occurrence -> one upsert, nothing spawnable.
    expect(tick.upserts).toHaveLength(1)
    expect(tick.spawnable).toHaveLength(0)
    // Still scheduled for the future regardless of the active occurrence.
    expect(tick.nextWakeAt).toBe(utc(2024, 1, 1, 0, 4))
  })

  it('returns nextWakeAt null when nothing is scheduled', () => {
    const def = definition('auto-1', [revision({ enabled: false })])
    const tick = planSchedulerTick({
      definitions: [def],
      occurrences: [],
      lastCheckedAt: T00,
      now: T01,
      ...counters()
    })

    expect(tick.upserts).toHaveLength(0)
    expect(tick.spawnable).toHaveLength(0)
    expect(tick.nextWakeAt).toBeNull()
  })
})
