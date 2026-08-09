import { describe, expect, it } from 'vitest'
import type { JournalReadResult, NormalizedEvent } from '@ops/events'
import type { TimelineState } from '@ops/web-client-core'
import { mergeRead } from './timelineMerge'

function e(cursor: number): NormalizedEvent {
  return {
    id: `e${cursor}`,
    cursor,
    timestamp: cursor,
    repoId: null,
    rootWorkflowId: 'w',
    rootWorkflowKind: 'session',
    parentWorkerId: null,
    workerId: 'w',
    workerKind: 'session',
    role: null,
    harness: null,
    model: null,
    attempt: 1,
    kind: 'lifecycle',
    summary: `e${cursor}`,
    evidenceRefs: [],
    source: { sessionId: 'w' }
  }
}

function st(events: NormalizedEvent[], cursor: number, needsResyncFrom: number | null): TimelineState {
  return { events, cursor, needsResyncFrom }
}

describe('mergeRead', () => {
  it('unions events and dedupes by cursor (page wins)', () => {
    const read: JournalReadResult = { events: [e(2), e(3), e(4)], latestCursor: 4, gap: null }
    const merged = mergeRead(st([e(1), e(2)], 2, 5), read)
    expect(merged.events.map((x) => x.cursor)).toEqual([1, 2, 3, 4])
    expect(merged.cursor).toBe(4)
    expect(merged.needsResyncFrom).toBeNull()
  })

  it('clears the resync flag even when the page adds nothing', () => {
    const merged = mergeRead(st([e(1)], 1, 2), { events: [], latestCursor: 1, gap: null })
    expect(merged.needsResyncFrom).toBeNull()
    expect(merged.events.map((x) => x.cursor)).toEqual([1])
  })

  it('never regresses the cursor', () => {
    const merged = mergeRead(st([e(10)], 10, null), { events: [], latestCursor: 3, gap: null })
    expect(merged.cursor).toBe(10)
  })
})
