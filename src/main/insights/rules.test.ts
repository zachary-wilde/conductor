import { describe, expect, it } from 'vitest'
import { EMPTY_INSIGHT_STATE, INSIGHT_GLOBAL_COOLDOWN_MS } from '@shared/insights'
import { collectCandidates, evaluate } from './engine'
import type { InsightDispatchSnapshot, InsightRule, InsightSnapshot } from './types'
import { MINUTE } from './types'
import { RULES } from './rules'

const dispatch = (over: Partial<InsightDispatchSnapshot> = {}): InsightDispatchSnapshot => ({
  key: 'brief-1:1000:ravel/brief-1',
  briefId: 'brief-1',
  briefTitle: 'token refresh',
  role: 'lead-engineer',
  harness: 'claude',
  model: null,
  status: 'completed',
  startedAt: 1000,
  endedAt: 2000,
  changedPaths: ['src/auth.ts'],
  protectedPaths: [],
  additions: 10,
  deletions: 2,
  commits: 1,
  contextRequests: 0,
  attempt: 1,
  usage: { inputTokens: 100, outputTokens: 100, costUsd: null },
  verification: { ok: true, output: '' },
  ...over
})

const snap = (over: Partial<InsightSnapshot> = {}): InsightSnapshot => ({
  now: 10_000,
  trigger: 'child-exit',
  ravel: null,
  sessions: [],
  dispatches: [dispatch()],
  roleMedianOutputTokens: {},
  openingPromptWords: 0,
  ...over
})

const fired = (s: InsightSnapshot): string[] => collectCandidates(s).map((c) => c.ruleId)
const messageOf = (s: InsightSnapshot, id: string): string =>
  collectCandidates(s).find((c) => c.ruleId === id)?.message ?? ''

describe('insight rules', () => {
  it('a clean single dispatch says nothing alarming', () => {
    const ids = fired(snap())
    expect(ids).not.toContain('scope.do-not-touch')
    expect(ids).not.toContain('coordination.file-overlap')
    expect(ids).not.toContain('verification.exit-ok-verify-failed')
  })

  it('flags a change inside a do-not-touch directory, not merely a name collision', () => {
    const inside = snap({
      dispatches: [dispatch({ changedPaths: ['src/main/store.ts'], protectedPaths: ['src/main'] })]
    })
    expect(fired(inside)).toContain('scope.do-not-touch')

    // `src/mainframe.ts` starts with the guarded string but is not inside the directory.
    const adjacent = snap({
      dispatches: [dispatch({ changedPaths: ['src/mainframe.ts'], protectedPaths: ['src/main'] })]
    })
    expect(fired(adjacent)).not.toContain('scope.do-not-touch')
  })

  it('normalises backslashes so Windows paths match the guard', () => {
    const s = snap({
      dispatches: [dispatch({ changedPaths: ['src\\main\\store.ts'], protectedPaths: ['src/main'] })]
    })
    expect(fired(s)).toContain('scope.do-not-touch')
  })

  it('reports overlap only between children that are still running', () => {
    const live = snap({
      dispatches: [
        dispatch({ key: 'a', status: 'active', changedPaths: ['src/auth.ts'] }),
        dispatch({ key: 'b', status: 'active', changedPaths: ['src/auth.ts'] })
      ]
    })
    expect(fired(live)).toContain('coordination.file-overlap')
    expect(messageOf(live, 'coordination.file-overlap')).toContain('2 agents are editing src/auth.ts')

    const oneFinished = snap({
      dispatches: [
        dispatch({ key: 'a', status: 'active', changedPaths: ['src/auth.ts'] }),
        dispatch({ key: 'b', status: 'completed', changedPaths: ['src/auth.ts'] })
      ]
    })
    expect(fired(oneFinished)).not.toContain('coordination.file-overlap')
  })

  it('notices an implementer that finished without changing anything', () => {
    const s = snap({ dispatches: [dispatch({ role: 'lead-engineer', changedPaths: [] })] })
    expect(fired(s)).toContain('progress.implementer-no-diff')
  })

  it('does not accuse an auditor that only read', () => {
    const quiet = snap({ dispatches: [dispatch({ role: 'auditor', changedPaths: [] })] })
    expect(fired(quiet)).not.toContain('scope.auditor-wrote-code')

    const wrote = snap({ dispatches: [dispatch({ role: 'auditor', changedPaths: ['a.ts'] })] })
    expect(fired(wrote)).toContain('scope.auditor-wrote-code')
  })

  it('separates a failed verification from a missing one', () => {
    const failed = snap({ dispatches: [dispatch({ verification: { ok: false, output: 'boom' } })] })
    expect(fired(failed)).toContain('verification.exit-ok-verify-failed')

    const none = snap({ dispatches: [dispatch({ verification: null })] })
    expect(fired(none)).toContain('verification.none-configured')
    expect(fired(none)).not.toContain('verification.exit-ok-verify-failed')
  })

  it('only calls it suspiciously green with at least three passing children', () => {
    const two = snap({ dispatches: [dispatch({ key: 'a' }), dispatch({ key: 'b' })] })
    expect(fired(two)).not.toContain('verification.suspiciously-green')

    const three = snap({
      dispatches: [dispatch({ key: 'a' }), dispatch({ key: 'b' }), dispatch({ key: 'c' })]
    })
    expect(fired(three)).toContain('verification.suspiciously-green')
  })

  it('counts retries and context requests at their thresholds, not below', () => {
    expect(fired(snap({ dispatches: [dispatch({ attempt: 2 })] }))).not.toContain(
      'progress.brief-retried'
    )
    expect(fired(snap({ dispatches: [dispatch({ attempt: 3 })] }))).toContain('progress.brief-retried')

    expect(fired(snap({ dispatches: [dispatch({ contextRequests: 2 })] }))).not.toContain(
      'coordination.context-requests'
    )
    expect(fired(snap({ dispatches: [dispatch({ contextRequests: 3 })] }))).toContain(
      'coordination.context-requests'
    )
  })

  it('reports a dominant token consumer as a percentage of the fleet', () => {
    const s = snap({
      dispatches: [
        dispatch({ key: 'a', usage: { inputTokens: 0, outputTokens: 900, costUsd: null } }),
        dispatch({ key: 'b', usage: { inputTokens: 0, outputTokens: 100, costUsd: null } })
      ]
    })
    expect(messageOf(s, 'cost.one-dispatch-dominates')).toContain('90%')
  })

  it('compares against the role median only when one is known', () => {
    const heavy = dispatch({ usage: { inputTokens: 0, outputTokens: 1000, costUsd: null } })
    expect(fired(snap({ dispatches: [heavy] }))).not.toContain('cost.above-role-median')

    const withMedian = snap({
      dispatches: [heavy],
      roleMedianOutputTokens: { 'lead-engineer': 400 }
    })
    expect(messageOf(withMedian, 'cost.above-role-median')).toContain('2.5×')
  })

  it('measures elapsed time from the injected clock, never a real one', () => {
    const running = dispatch({ status: 'active', startedAt: 0, commits: 0 })
    expect(fired(snap({ now: 40 * MINUTE, dispatches: [running] }))).not.toContain(
      'progress.long-run-no-commits'
    )
    const late = snap({ now: 47 * MINUTE, dispatches: [running] })
    expect(fired(late)).toContain('progress.long-run-no-commits')
    expect(messageOf(late, 'progress.long-run-no-commits')).toContain('47 minutes')
  })

  it('does not nag about a long run that has been committing', () => {
    const s = snap({
      now: 90 * MINUTE,
      dispatches: [dispatch({ status: 'active', startedAt: 0, commits: 4 })]
    })
    expect(fired(s)).not.toContain('progress.long-run-no-commits')
  })

  it('contrasts a short prompt with a large diff', () => {
    const s = snap({
      openingPromptWords: 6,
      dispatches: [dispatch({ changedPaths: Array.from({ length: 31 }, (_, i) => `f${i}.ts`) })]
    })
    expect(messageOf(s, 'scope.small-ask-big-diff')).toContain('31 files')
  })

  it('every rule has a unique id and a non-empty cooldown', () => {
    const ids = RULES.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(RULES.every((r) => r.cooldownMs > 0)).toBe(true)
  })
})

describe('surfacing policy', () => {
  const noisy: InsightSnapshot = snap({
    dispatches: [
      dispatch({ key: 'a', changedPaths: ['src/main/x.ts'], protectedPaths: ['src/main'] }),
      dispatch({ key: 'b', role: 'auditor', changedPaths: ['y.ts'] })
    ]
  })

  it('surfaces at most one insight even when several rules fire', () => {
    expect(collectCandidates(noisy).length).toBeGreaterThan(1)
    const { insight } = evaluate(noisy, EMPTY_INSIGHT_STATE)
    expect(insight).not.toBeNull()
  })

  it('picks the most severe candidate first', () => {
    const { insight } = evaluate(noisy, EMPTY_INSIGHT_STATE)
    expect(insight?.severity).toBe('critical')
    expect(insight?.ruleId).toBe('scope.do-not-touch')
  })

  it('stays quiet inside the global cooldown', () => {
    const first = evaluate(noisy, EMPTY_INSIGHT_STATE)
    const soon = { ...noisy, now: noisy.now + INSIGHT_GLOBAL_COOLDOWN_MS - 1 }
    expect(evaluate(soon, first.state).insight).toBeNull()
  })

  it('never repeats the same evidence, even long afterwards', () => {
    const first = evaluate(noisy, EMPTY_INSIGHT_STATE)
    const muchLater = { ...noisy, now: noisy.now + 24 * 60 * MINUTE }
    const second = evaluate(muchLater, first.state)
    expect(second.insight?.dedupeKey).not.toBe(first.insight?.dedupeKey)
  })

  it('re-evaluates rather than queueing: a loser resurfaces only if still true', () => {
    const first = evaluate(noisy, EMPTY_INSIGHT_STATE)
    expect(first.insight?.ruleId).toBe('scope.do-not-touch')

    // Later, with the same state: the winner is deduped by evidence, but the auditor
    // finding is still true right now, so it is current truth rather than a stale queue
    // entry and should surface.
    const later = { ...noisy, now: noisy.now + 24 * 60 * MINUTE }
    const second = evaluate(later, first.state)
    expect(second.insight?.ruleId).toBe('scope.auditor-wrote-code')

    // Once both have been said, silence — nothing is being held back.
    const laterStill = { ...noisy, now: noisy.now + 48 * 60 * MINUTE }
    expect(evaluate(laterStill, second.state).insight).toBeNull()
  })

  it('a rule that throws cannot break the pass', () => {
    const exploding: InsightRule = {
      id: 'boom',
      category: 'progress',
      severity: 'critical',
      cooldownMs: 1000,
      predicate: () => {
        throw new Error('nope')
      },
      format: () => ({ message: 'unreachable', dedupeKey: 'x' })
    }
    expect(() => collectCandidates(snap(), [exploding, ...RULES])).not.toThrow()
  })

  it('evaluation schedules nothing — it is a pure function of its inputs', () => {
    const a = evaluate(noisy, EMPTY_INSIGHT_STATE)
    const b = evaluate(noisy, EMPTY_INSIGHT_STATE)
    expect(a.insight).toEqual(b.insight)
  })
})
