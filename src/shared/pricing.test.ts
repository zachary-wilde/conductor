import { describe, expect, test } from 'vitest'
import { addUsage, defaultModelForRole, estimateCostUsd, estimateTokens } from './pricing'
import {
  applyBehaviorToPrompt,
  BEHAVIOR_BRIEFS,
  BEHAVIOR_LABELS,
  SESSION_BEHAVIORS
} from './types'

describe('token estimation', () => {
  test('rounds up to whole tokens and floors negatives at zero', () => {
    expect(estimateTokens(0)).toBe(0)
    expect(estimateTokens(10)).toBe(3)
    expect(estimateTokens(-5)).toBe(0)
  })
})

describe('cost estimation', () => {
  test('prices a known model per million tokens', () => {
    expect(estimateCostUsd('haiku', 1_000_000, 0)).toBe(0.8)
    expect(estimateCostUsd('haiku', 0, 1_000_000)).toBe(4)
  })

  // Zero would read as free; an unpriced model must read as unknown.
  test('yields null for an unknown or absent model', () => {
    expect(estimateCostUsd('no-such-model', 1000, 1000)).toBeNull()
    expect(estimateCostUsd(null, 1000, 1000)).toBeNull()
  })
})

describe('usage addition', () => {
  test('sums tokens and keeps the cost null when either side is unknown', () => {
    expect(
      addUsage({ inputTokens: 1, outputTokens: 2, costUsd: 0.5 }, { inputTokens: 3, outputTokens: 4, costUsd: null })
    ).toEqual({ inputTokens: 4, outputTokens: 6, costUsd: null })
    expect(
      addUsage({ inputTokens: 1, outputTokens: 2, costUsd: 0.5 }, { inputTokens: 3, outputTokens: 4, costUsd: 0.25 })
    ).toEqual({ inputTokens: 4, outputTokens: 6, costUsd: 0.75 })
  })

  // The empty starting usage carries a null cost; treating that as unknown
  // would pin every running total at null for the life of the ravel.
  test('treats a zero-token usage as a cost identity, not an unknown', () => {
    expect(
      addUsage({ inputTokens: 0, outputTokens: 0, costUsd: null }, { inputTokens: 3, outputTokens: 4, costUsd: 0.25 })
    ).toEqual({ inputTokens: 3, outputTokens: 4, costUsd: 0.25 })
  })
})

describe('role routing', () => {
  test('routes Claude roles to their tier and leaves other harnesses alone', () => {
    expect(defaultModelForRole('minor-task', 'claude')).toBe('haiku')
    expect(defaultModelForRole('auditor', 'claude')).toBe('sonnet')
    expect(defaultModelForRole('lead-engineer', 'claude')).toBe('opus')
    expect(defaultModelForRole('minor-task', 'zai')).toBeUndefined()
    expect(defaultModelForRole('minor-task', 'codex')).toBeUndefined()
  })
})

describe('specialist roles', () => {
  test('includes every specialist role and excludes orchestrator', () => {
    expect(SESSION_BEHAVIORS).toEqual([
      'none',
      'lead-engineer',
      'auditor',
      'minor-task',
      'researcher',
      'test-engineer',
      'security-engineer',
      'performance-engineer',
      'release-engineer'
    ])
    expect(BEHAVIOR_LABELS).toMatchObject({
      researcher: 'Researcher',
      'test-engineer': 'Test Engineer',
      'security-engineer': 'Security Engineer',
      'performance-engineer': 'Performance Engineer',
      'release-engineer': 'Release Engineer'
    })
    expect(BEHAVIOR_LABELS).not.toHaveProperty('orchestrator')
    expect(BEHAVIOR_BRIEFS).not.toHaveProperty('orchestrator')
  })

  test('prefixes prompts with each new specialist brief', () => {
    for (const role of [
      'researcher',
      'test-engineer',
      'security-engineer',
      'performance-engineer',
      'release-engineer'
    ] as const) {
      expect(applyBehaviorToPrompt(role, 'Do the work')).toContain(BEHAVIOR_BRIEFS[role])
    }
  })

  test('routes new Claude roles to Sonnet', () => {
    expect(defaultModelForRole('researcher', 'claude')).toBe('sonnet')
    expect(defaultModelForRole('test-engineer', 'claude')).toBe('sonnet')
    expect(defaultModelForRole('security-engineer', 'claude')).toBe('sonnet')
    expect(defaultModelForRole('performance-engineer', 'claude')).toBe('sonnet')
    expect(defaultModelForRole('release-engineer', 'claude')).toBe('sonnet')
  })
})
