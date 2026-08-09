import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEventJournal } from './event-journal'
import type { UnsequencedEvent } from './events'

// Fixed epoch constants — never Date.now(). Times here are arbitrary ms.
const T0 = 1_700_000_000_000

/**
 * Build an UnsequencedEvent from a 1-based index. Fixed timestamp derived from
 * the index so appends are deterministic; every field has a value that fits the
 * NormalizedEvent contract so the journal's deep clone round-trips faithfully.
 */
const event = (i: number, over: Partial<UnsequencedEvent> = {}): UnsequencedEvent => ({
  id: `evt-${i}`,
  timestamp: T0 + i * 60_000,
  repoId: null,
  rootWorkflowId: 'wf-1',
  rootWorkflowKind: 'session',
  parentWorkerId: null,
  workerId: 'worker-1',
  workerKind: 'session',
  role: null,
  harness: 'claude',
  model: null,
  attempt: 1,
  kind: 'lifecycle',
  summary: `event ${i}`,
  evidenceRefs: [],
  source: {},
  ...over
})

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'event-journal-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('createEventJournal — cursors', () => {
  it('assigns strictly increasing cursors starting at 1', () => {
    const journal = createEventJournal({ dir })
    expect(journal.append(event(1)).cursor).toBe(1)
    expect(journal.append(event(2)).cursor).toBe(2)
    expect(journal.append(event(3)).cursor).toBe(3)
    expect(journal.latest()).toBe(3)
  })

  it('reports latest 0 and range null on a fresh journal', () => {
    const journal = createEventJournal({ dir })
    expect(journal.latest()).toBe(0)
    expect(journal.range()).toBeNull()
    expect(journal.readAfter(0)).toEqual({ events: [], latestCursor: 0, gap: null })
  })

  it('accepts a lazy dir resolver, not just a string', () => {
    const journal = createEventJournal({ dir: () => dir })
    expect(journal.append(event(1)).cursor).toBe(1)
    expect(journal.latest()).toBe(1)
  })
})

describe('append / readAfter round-trip', () => {
  it('round-trips appended events in cursor order', () => {
    const journal = createEventJournal({ dir })
    journal.append(event(1))
    journal.append(event(2))
    journal.append(event(3))

    const result = journal.readAfter(0)
    expect(result.events.map((e) => e.cursor)).toEqual([1, 2, 3])
    expect(result.events.map((e) => e.id)).toEqual(['evt-1', 'evt-2', 'evt-3'])
    expect(result.events.map((e) => e.summary)).toEqual(['event 1', 'event 2', 'event 3'])
    expect(result.latestCursor).toBe(3)
    expect(result.gap).toBeNull()
  })

  it('readAfter respects the boundary (strictly greater than afterCursor)', () => {
    const journal = createEventJournal({ dir })
    journal.append(event(1))
    journal.append(event(2))
    journal.append(event(3))

    expect(journal.readAfter(1).events.map((e) => e.cursor)).toEqual([2, 3])
    expect(journal.readAfter(2).events.map((e) => e.cursor)).toEqual([3])
  })

  it('readAfter(latest) returns empty with null gap', () => {
    const journal = createEventJournal({ dir })
    journal.append(event(1))
    journal.append(event(2))

    const result = journal.readAfter(journal.latest())
    expect(result.events).toEqual([])
    expect(result.gap).toBeNull()
    expect(result.latestCursor).toBe(2)
  })
})

describe('persistence through reopen', () => {
  it('resumes cursors above the prior max and still reads prior events', () => {
    const first = createEventJournal({ dir })
    first.append(event(1))
    first.append(event(2))
    first.append(event(3))
    expect(first.latest()).toBe(3)

    const reopened = createEventJournal({ dir })
    expect(reopened.latest()).toBe(3)
    expect(reopened.range()).toEqual({ firstCursor: 1, lastCursor: 3 })
    expect(reopened.readAfter(0).events.map((e) => e.cursor)).toEqual([1, 2, 3])

    // No reissue: the next cursor continues above the persisted max.
    expect(reopened.append(event(4)).cursor).toBe(4)
    expect(reopened.latest()).toBe(4)
  })

  it('never reissues a cursor across many reopen cycles', () => {
    let next = 1
    for (let cycle = 0; cycle < 4; cycle++) {
      const journal = createEventJournal({ dir })
      expect(journal.append(event(next)).cursor).toBe(next)
      next += 1
    }
    expect(createEventJournal({ dir }).latest()).toBe(next - 1)
  })
})

describe('rotation', () => {
  it('drops the oldest segment once maxSegments*segmentSize is exceeded', () => {
    const journal = createEventJournal({ dir, segmentSize: 2, maxSegments: 2 })
    for (let i = 1; i <= 6; i++) journal.append(event(i))

    // Retained segments are [3,4] and [5,6]: only the last four remain.
    expect(journal.range()).toEqual({ firstCursor: 3, lastCursor: 6 })
    expect(journal.readAfter(0).events.map((e) => e.cursor)).toEqual([3, 4, 5, 6])
    expect(journal.latest()).toBe(6)
  })

  it('advances range().firstCursor as the oldest segment rotates out', () => {
    const journal = createEventJournal({ dir, segmentSize: 2, maxSegments: 2 })
    journal.append(event(1))
    journal.append(event(2))
    expect(journal.range()).toEqual({ firstCursor: 1, lastCursor: 2 })
    journal.append(event(3)) // new segment; still within bound
    expect(journal.range()).toEqual({ firstCursor: 1, lastCursor: 3 })
    journal.append(event(4))
    journal.append(event(5)) // third full segment forces the oldest out
    expect(journal.range()?.firstCursor).toBe(3)
  })

  it('reports a gap when reading from a cursor that has rotated out', () => {
    const journal = createEventJournal({ dir, segmentSize: 2, maxSegments: 2 })
    for (let i = 1; i <= 6; i++) journal.append(event(i))

    // Earliest retained is cursor 3; afterCursor 1 wants cursor 2, which is gone.
    const result = journal.readAfter(1)
    expect(result.gap).not.toBeNull()
    expect(result.gap!.requestedAfter).toBe(1)
    expect(result.gap!.earliestAvailable).toBe(3)
    // Retained events are still returned alongside the gap.
    expect(result.events.map((e) => e.cursor)).toEqual([3, 4, 5, 6])
  })

  it('reports no gap when reading from the predecessor of the earliest', () => {
    const journal = createEventJournal({ dir, segmentSize: 2, maxSegments: 2 })
    for (let i = 1; i <= 6; i++) journal.append(event(i))

    // afterCursor 2 wants cursor 3 — exactly the earliest retained: no gap.
    const result = journal.readAfter(2)
    expect(result.gap).toBeNull()
    expect(result.events.map((e) => e.cursor)).toEqual([3, 4, 5, 6])
  })

  it('survives reopen with rotation already applied', () => {
    const journal = createEventJournal({ dir, segmentSize: 2, maxSegments: 2 })
    for (let i = 1; i <= 6; i++) journal.append(event(i))

    const reopened = createEventJournal({ dir, segmentSize: 2, maxSegments: 2 })
    expect(reopened.range()).toEqual({ firstCursor: 3, lastCursor: 6 })
    expect(reopened.latest()).toBe(6)
    expect(reopened.readAfter(1).gap).toEqual({
      requestedAfter: 1,
      earliestAvailable: 3
    })
    expect(reopened.append(event(7)).cursor).toBe(7)
  })
})

describe('readAfter limit', () => {
  it('caps the returned batch and continues from the last returned cursor', () => {
    const journal = createEventJournal({ dir })
    for (let i = 1; i <= 5; i++) journal.append(event(i))

    const first = journal.readAfter(0, 2)
    expect(first.events.map((e) => e.cursor)).toEqual([1, 2])
    expect(first.gap).toBeNull()
    expect(first.latestCursor).toBe(5)

    const second = journal.readAfter(first.events[1].cursor, 2)
    expect(second.events.map((e) => e.cursor)).toEqual([3, 4])

    const third = journal.readAfter(second.events[1].cursor, 2)
    expect(third.events.map((e) => e.cursor)).toEqual([5])

    const done = journal.readAfter(third.events[0].cursor)
    expect(done.events).toEqual([])
    expect(done.gap).toBeNull()
  })
})

describe('getters return copies', () => {
  it('mutating a returned event does not affect the journal', () => {
    const journal = createEventJournal({ dir })
    const sequenced = journal.append(event(1))
    sequenced.summary = 'tampered'
    sequenced.evidenceRefs.push('forged')

    expect(journal.readAfter(0).events[0].summary).toBe('event 1')
    expect(journal.readAfter(0).events[0].evidenceRefs).toEqual([])
  })

  it('mutating the input event does not affect the journal', () => {
    const journal = createEventJournal({ dir })
    const input = event(1)
    journal.append(input)
    input.summary = 'mutated after append'

    expect(journal.readAfter(0).events[0].summary).toBe('event 1')
  })
})

describe('on-disk layout', () => {
  it('writes segment-<firstCursor>.json files and a meta.json', () => {
    const journal = createEventJournal({ dir, segmentSize: 2 })
    journal.append(event(1))
    journal.append(event(2))
    journal.append(event(3))

    const files = readdirSync(dir).sort()
    expect(files).toContain('meta.json')
    expect(files).toContain('segment-1.json')
    expect(files).toContain('segment-3.json')

    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
    expect(meta.nextCursor).toBe(4)
    expect(meta.segmentFirstCursors).toEqual([1, 3])

    const segment1 = JSON.parse(readFileSync(join(dir, 'segment-1.json'), 'utf8'))
    expect(segment1.map((e: { cursor: number }) => e.cursor)).toEqual([1, 2])
  })
})

describe('durability — corrupt files are surfaced, not zeroed', () => {
  it('does not overwrite an unparseable meta; surfaces the error', () => {
    createEventJournal({ dir }).append(event(1))
    const metaPath = join(dir, 'meta.json')
    writeFileSync(metaPath, '{not valid json')

    const reopened = createEventJournal({ dir })
    expect(() => reopened.range()).toThrow(/failed to load event journal/)
    expect(() => reopened.readAfter(0)).toThrow(/failed to load event journal/)
    expect(() => reopened.latest()).toThrow(/failed to load event journal/)
    // The corrupt file is byte-for-byte untouched.
    expect(readFileSync(metaPath, 'utf8')).toBe('{not valid json')
  })

  it('does not overwrite an unparseable segment; surfaces the error', () => {
    createEventJournal({ dir }).append(event(1))
    const segName = readdirSync(dir).find((f) => f.startsWith('segment-'))!
    const segPath = join(dir, segName)
    writeFileSync(segPath, '{not valid json')

    const reopened = createEventJournal({ dir })
    expect(() => reopened.readAfter(0)).toThrow(/failed to load event journal/)
    expect(readFileSync(segPath, 'utf8')).toBe('{not valid json')
  })

  it('rejects a malformed-but-parseable segment (non-contiguous cursors)', () => {
    const journal = createEventJournal({ dir })
    journal.append(event(1))
    journal.append(event(2))

    const segName = readdirSync(dir).find((f) => f.startsWith('segment-'))!
    const segPath = join(dir, segName)
    const data = JSON.parse(readFileSync(segPath, 'utf8'))
    data[1].cursor = 99
    writeFileSync(segPath, JSON.stringify(data))

    const reopened = createEventJournal({ dir })
    expect(() => reopened.range()).toThrow(/failed to load event journal/)
  })

  it('rejects a malformed-but-parseable meta (invalid nextCursor)', () => {
    createEventJournal({ dir }).append(event(1))
    const metaPath = join(dir, 'meta.json')
    writeFileSync(metaPath, JSON.stringify({ version: 1, nextCursor: 'nope', segmentFirstCursors: [] }))

    const reopened = createEventJournal({ dir })
    expect(() => reopened.latest()).toThrow(/failed to load event journal/)
    expect(readFileSync(metaPath, 'utf8')).toBe(
      JSON.stringify({ version: 1, nextCursor: 'nope', segmentFirstCursors: [] })
    )
  })

  it('leaves healthy segment files untouched when meta is corrupt', () => {
    createEventJournal({ dir }).append(event(1))
    const segName = readdirSync(dir).find((f) => f.startsWith('segment-'))!
    const segPath = join(dir, segName)
    const segmentBefore = readFileSync(segPath, 'utf8')
    writeFileSync(join(dir, 'meta.json'), '{broken')

    expect(() => createEventJournal({ dir }).latest()).toThrow()
    expect(readFileSync(segPath, 'utf8')).toBe(segmentBefore)
  })
})

describe('recovery — nextCursor never collides after a partial write', () => {
  it('reopens above the highest persisted cursor when meta lags the segments', () => {
    // Simulate a crash that advanced the segment but left meta.nextCursor behind:
    // append two events (segment-1 holds cursors 1,2), then rewrite meta with a
    // stale nextCursor. The reopened journal must still not reissue cursor 2.
    const journal = createEventJournal({ dir })
    journal.append(event(1))
    journal.append(event(2))
    writeFileSync(
      join(dir, 'meta.json'),
      JSON.stringify({ version: 1, nextCursor: 2, segmentFirstCursors: [1] })
    )

    const reopened = createEventJournal({ dir })
    expect(reopened.latest()).toBe(2)
    // Reconciled against the segment: the next assigned cursor clears cursor 2.
    expect(reopened.append(event(3)).cursor).toBe(3)
    expect(reopened.readAfter(0).events.map((e) => e.cursor)).toEqual([1, 2, 3])
  })
})
