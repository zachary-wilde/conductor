import { describe, expect, it, vi } from 'vitest'
import { createLiveFeed } from './live-feed'
import type { EventJournal } from './event-journal'
import type { EventCursor, JournalReadResult, NormalizedEvent, UnsequencedEvent } from './events'

// Fixed epoch constants — never Date.now(). Times here are arbitrary ms.
const T0 = 1_700_000_000_000

/**
 * Build an UnsequencedEvent from a 1-based index, mirroring the builder used in
 * event-journal.test.ts so every field carries a value that satisfies the
 * NormalizedEvent contract. Any field is overridable.
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

/**
 * A minimal in-memory EventJournal that assigns strictly increasing cursors
 * starting at 1 — enough to exercise the feed without touching the filesystem.
 * `calls` records the public method invoked (in order) so a test can assert
 * that `record` appends to the journal BEFORE notifying subscribers, and that
 * `latest`/`readAfter` actually delegate.
 */
function fakeJournal(): EventJournal & {
  calls: string[]
  stored: NormalizedEvent[]
} {
  const calls: string[] = []
  const stored: NormalizedEvent[] = []
  let next = 1
  return {
    calls,
    stored,
    append: (e: UnsequencedEvent): NormalizedEvent => {
      calls.push('append')
      const sequenced: NormalizedEvent = { ...e, cursor: next }
      next += 1
      stored.push(sequenced)
      return sequenced
    },
    readAfter: (after: EventCursor, limit?: number): JournalReadResult => {
      calls.push('readAfter')
      const matched = stored.filter((e) => e.cursor > after)
      const capped = limit != null ? matched.slice(0, limit) : matched
      const first = stored.length > 0 ? stored[0].cursor : 0
      const last = stored.length > 0 ? stored[stored.length - 1].cursor : 0
      const gap =
        after < first && stored.length > 0
          ? { requestedAfter: after, earliestAvailable: first }
          : null
      return { events: capped, latestCursor: last, gap }
    },
    range: () => {
      calls.push('range')
      if (stored.length === 0) return null
      return { firstCursor: stored[0].cursor, lastCursor: stored[stored.length - 1].cursor }
    },
    latest: (): EventCursor => {
      calls.push('latest')
      return stored.length > 0 ? stored[stored.length - 1].cursor : 0
    }
  }
}

describe('createLiveFeed', () => {
  it('record appends to the journal BEFORE notifying, and returns the cursor-bearing event', () => {
    const journal = fakeJournal()
    const feed = createLiveFeed(journal)
    const seen: NormalizedEvent[] = []

    feed.subscribe((e) => {
      journal.calls.push('notify')
      seen.push(e)
    })

    const returned = feed.record(event(1))

    // The journal was appended first; only then did the subscriber run.
    expect(journal.calls).toEqual(['append', 'notify'])
    // The subscriber saw exactly the sequenced event record returned.
    expect(returned.cursor).toBe(1)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBe(returned)
  })

  it('notifies every active subscriber with the same sequenced event', () => {
    const feed = createLiveFeed(fakeJournal())
    const a: NormalizedEvent[] = []
    const b: NormalizedEvent[] = []
    const c: NormalizedEvent[] = []

    feed.subscribe((e) => a.push(e))
    feed.subscribe((e) => b.push(e))
    feed.subscribe((e) => c.push(e))

    feed.record(event(1))
    feed.record(event(2))

    expect(a.map((e) => e.cursor)).toEqual([1, 2])
    expect(b.map((e) => e.cursor)).toEqual([1, 2])
    expect(c.map((e) => e.cursor)).toEqual([1, 2])
  })

  it('unsubscribe stops delivery to that subscriber only', () => {
    const feed = createLiveFeed(fakeJournal())
    const a: number[] = []
    const b: number[] = []

    const unsubA = feed.subscribe((e) => a.push(e.cursor))
    feed.subscribe((e) => b.push(e.cursor))

    feed.record(event(1))
    unsubA()
    feed.record(event(2))

    // A received only the event before it unsubscribed; B received both.
    expect(a).toEqual([1])
    expect(b).toEqual([1, 2])
  })

  it('unsubscribe is idempotent — calling it twice does nothing on the second call', () => {
    const feed = createLiveFeed(fakeJournal())
    const a: number[] = []
    const b: number[] = []

    const unsubA = feed.subscribe((e) => a.push(e.cursor))
    feed.subscribe((e) => b.push(e.cursor))

    unsubA()
    unsubA() // harmless repeat
    feed.record(event(1))

    expect(a).toEqual([])
    expect(b).toEqual([1])
  })

  it('a throwing subscriber does not stop the others and record still returns', () => {
    const feed = createLiveFeed(fakeJournal())
    const good: NormalizedEvent[] = []
    const boom = vi.fn(() => {
      throw new Error('subscriber exploded')
    })

    // console.error would otherwise litter the test output; capture and assert
    // it is used so a bad subscriber is observable, not silent.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    feed.subscribe(boom)
    feed.subscribe((e) => good.push(e))

    // record must return normally despite a subscriber throwing.
    let returned: NormalizedEvent | undefined
    expect(() => {
      returned = feed.record(event(1))
    }).not.toThrow()

    expect(boom).toHaveBeenCalledTimes(1)
    // The good subscriber still received the in-flight event.
    expect(good).toHaveLength(1)
    expect(returned?.cursor).toBe(1)
    expect(errorSpy).toHaveBeenCalled()

    errorSpy.mockRestore()
  })

  it('a subscriber registered mid-fanout does not receive the in-flight event', () => {
    const feed = createLiveFeed(fakeJournal())
    const early: number[] = []
    const late: number[] = []

    // The early subscriber registers a second subscriber WHILE being notified.
    // Because fanout iterates a snapshot taken before delivery, the late
    // subscriber must miss the event currently in flight.
    let registerLate: () => void
    feed.subscribe((e) => {
      early.push(e.cursor)
      registerLate()
    })
    registerLate = () => feed.subscribe((e) => late.push(e.cursor))

    feed.record(event(1))
    feed.record(event(2))

    // The in-flight event (cursor 1) was not delivered to the late subscriber,
    // but the next one (cursor 2) — registered before that fanout — was.
    expect(early).toEqual([1, 2])
    expect(late).toEqual([2])
  })

  it('latest delegates straight to the journal', () => {
    const journal = fakeJournal()
    const feed = createLiveFeed(journal)

    expect(feed.latest()).toBe(0)
    feed.record(event(1))
    feed.record(event(2))
    expect(feed.latest()).toBe(2)
    // The feed forwards rather than tracking its own cursor.
    expect(journal.calls).toContain('latest')
  })

  it('readAfter delegates straight to the journal and reflects appends', () => {
    const journal = fakeJournal()
    const feed = createLiveFeed(journal)

    feed.record(event(1))
    feed.record(event(2))
    feed.record(event(3))

    const result = feed.readAfter(1, 10)
    expect(result.events.map((e) => e.cursor)).toEqual([2, 3])
    expect(result.latestCursor).toBe(3)
    expect(result.gap).toBeNull()
    expect(journal.calls).toContain('readAfter')

    // A requested cursor older than the earliest retained event reports a gap.
    const gapped = feed.readAfter(0)
    expect(gapped.gap).toEqual({ requestedAfter: 0, earliestAvailable: 1 })
  })
})
