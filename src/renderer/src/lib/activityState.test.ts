import { describe, expect, test } from 'vitest'
import type { PublicRavelConfig, RoundtableConfig, Session, SessionStatus } from '@shared/types'
import {
  ACTIVITY_META,
  activityStateOfRavel,
  activityStateOfRoundtable,
  activityStateOfSession
} from './activityState'

function session(status: SessionStatus): Session {
  return {
    id: 's',
    repoId: 'r',
    repoPath: 'p',
    worktreePath: 'w',
    branch: 'b',
    harness: 'claude',
    status,
    title: null,
    initialPrompt: null,
    createdAt: 0,
    kind: 'normal'
  } as Session
}

describe('activityStateOfSession', () => {
  test.each([
    ['starting', 'working'],
    ['running', 'working'],
    ['needs-input', 'needs-input'],
    ['closed', 'complete'],
    ['error', 'error']
  ] as const)('%s → %s', (status, expected) => {
    expect(activityStateOfSession(session(status))).toBe(expected)
  })
})

describe('activityStateOfRavel', () => {
  const ravel = (over: Partial<PublicRavelConfig>): PublicRavelConfig =>
    ({ status: 'idle', activity: 'idle', ...over }) as PublicRavelConfig

  test('error and completed win over activity', () => {
    expect(activityStateOfRavel(ravel({ status: 'error', activity: 'thinking' }))).toBe('error')
    expect(activityStateOfRavel(ravel({ status: 'completed', activity: 'thinking' }))).toBe('complete')
  })
  test('awaiting-approval and needs-clarification are needs-input', () => {
    expect(activityStateOfRavel(ravel({ status: 'awaiting-approval' }))).toBe('needs-input')
    expect(activityStateOfRavel(ravel({ activity: 'needs-clarification' }))).toBe('needs-input')
  })
  test('thinking or running is working; otherwise idle', () => {
    expect(activityStateOfRavel(ravel({ activity: 'thinking' }))).toBe('working')
    expect(activityStateOfRavel(ravel({ status: 'running' }))).toBe('working')
    expect(activityStateOfRavel(ravel({ status: 'paused' }))).toBe('idle')
  })
})

describe('activityStateOfRoundtable', () => {
  const table = (status: RoundtableConfig['status']): RoundtableConfig => ({ status }) as RoundtableConfig
  test.each([
    ['running', 'working'],
    ['concluded', 'complete'],
    ['error', 'error'],
    ['paused', 'idle'],
    ['idle', 'idle']
  ] as const)('%s → %s', (status, expected) => {
    expect(activityStateOfRoundtable(table(status))).toBe(expected)
  })
})

test('every state has metadata', () => {
  for (const state of ['working', 'idle', 'needs-input', 'complete', 'error'] as const) {
    expect(ACTIVITY_META[state].label.length).toBeGreaterThan(0)
    expect(ACTIVITY_META[state].dotClass.length).toBeGreaterThan(0)
  }
})
