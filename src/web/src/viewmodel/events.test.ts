import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '@ops/events'
import { formatClock, formatRelative, groupByKind, kindMeta, toneChip, toneText } from './events'

describe('kindMeta', () => {
  it('labels known kinds with semantic tones', () => {
    expect(kindMeta('commit').label).toBe('COMMIT')
    expect(kindMeta('failure').tone).toBe('red')
    expect(kindMeta('approval').tone).toBe('green')
    expect(kindMeta('automation').tone).toBe('purple')
  })
})

describe('tone helpers', () => {
  it('return class fragments for known tones', () => {
    expect(toneText('green')).toBe('text-accent-green')
    expect(toneChip('red')).toContain('text-[rgb(var(--danger))]')
  })
})

describe('formatClock', () => {
  it('formats HH:MM:SS', () => {
    const ts = new Date(2026, 0, 1, 13, 5, 9).getTime()
    expect(formatClock(ts)).toMatch(/^\d{2}:\d{2}:\d{2}$/)
  })
})

describe('formatRelative', () => {
  const now = new Date('2026-01-01T12:00:00Z').getTime()

  it('seconds under a minute', () => {
    expect(formatRelative(now - 5_000, now)).toBe('5s')
  })
  it('minutes under an hour', () => {
    expect(formatRelative(now - 120_000, now)).toBe('2m')
  })
  it('hours under a day', () => {
    expect(formatRelative(now - 3 * 3_600_000, now)).toBe('3h')
  })
  it('days beyond that', () => {
    expect(formatRelative(now - 2 * 86_400_000, now)).toBe('2d')
  })
  it('never goes negative', () => {
    expect(formatRelative(now + 5_000, now)).toBe('0s')
  })
})

describe('groupByKind', () => {
  function e(cursor: number, kind: NormalizedEvent['kind']): NormalizedEvent {
    return {
      id: `e${cursor}`,
      cursor,
      timestamp: cursor,
      repoId: null,
      rootWorkflowId: 'w',
      rootWorkflowKind: 'session',
      parentWorkerId: null,
      workerId: null,
      workerKind: null,
      role: null,
      harness: null,
      model: null,
      attempt: 1,
      kind,
      summary: '',
      evidenceRefs: [],
      source: {}
    }
  }

  it('groups consecutive same-kind runs, preserving order', () => {
    const groups = groupByKind([e(1, 'commit'), e(2, 'commit'), e(3, 'tool'), e(4, 'commit')])
    expect(groups.map((g) => [g.kind, g.events.length])).toEqual([
      ['commit', 2],
      ['tool', 1],
      ['commit', 1]
    ])
  })

  it('empty input yields no groups', () => {
    expect(groupByKind([])).toEqual([])
  })
})
