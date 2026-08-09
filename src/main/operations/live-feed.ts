// LIVE-FEED slice of the Operations Core: a write + fanout layer over an
// EventJournal that turns the journal's pull-only API into a push feed.
//
// This is the FEED slice of the Operations Core. The journal (./event-journal)
// is the single assigner of `cursor` and the single owner of durable storage,
// but it is pull-only: a reader must poll `readAfter` to learn anything
// happened. The timeline UI and downstream consumers want push semantics, so
// this module sits in front of the journal and adds exactly one fanout step:
//
//   record(event) -> journal.append(event)   (cursor assigned + persisted)
//                 -> notify every subscriber with the sequenced event
//
// The journal stays the source of truth for ordering and durability; the feed
// adds only transient in-process subscribers. It performs no I/O of its own
// beyond the injected journal, runs no timers, and holds no history — a
// subscriber that wants history calls `readAfter`, which this forwards
// verbatim to the journal.
//
// Two invariants are load-bearing here, and both mirror patterns already in
// the codebase:
//
//   1. ORDER. `record` appends to the journal FIRST, so the cursor is assigned
//      and persisted before any subscriber runs. A subscriber therefore always
//      sees an event that is already durably in the journal, and the sequenced
//      event handed to it is exactly the one `record` returns.
//
//   2. ISOLATION. Each subscriber is invoked inside its own try/catch, so one
//      bad subscriber can never take down a fanout, corrupt the journal, or
//      block the feed. This is the same failure-isolation pattern the insight
//      engine uses (see ../insights/engine.ts, where a throwing rule must never
//      take down an evaluation pass).
//
// The subscriber snapshot is taken BEFORE iteration: a callback that registers
// or unregisters during a fanout cannot change who receives the in-flight
// event. By the time any callback runs the fanout's set is already fixed.

import type { EventJournal } from './event-journal'
import type {
  EventCursor,
  JournalReadResult,
  NormalizedEvent,
  UnsequencedEvent
} from './events'

/**
 * Push feed over an {@link EventJournal}. `record` is the only mutator: it
 * appends to the journal and synchronously fans the sequenced event out to
 * every active subscriber. `subscribe`/`latest`/`readAfter` are read-side
 * conveniences; `latest` and `readAfter` delegate straight to the journal.
 */
export interface LiveFeed {
  /**
   * Append `event` to the journal (which assigns and persists its cursor), then
   * synchronously fan the sequenced event out to every subscriber active at the
   * moment of the fanout. Returns the sequenced event — identical to what every
   * subscriber received.
   */
  record(event: UnsequencedEvent): NormalizedEvent
  /**
   * Register `onEvent` for future `record` calls. The callback receives only
   * events recorded AFTER this call; it never sees history (use `readAfter`).
   * Returns an unsubscribe that is idempotent: calling it more than once is a
   * harmless no-op.
   */
  subscribe(onEvent: (event: NormalizedEvent) => void): () => void
  /** Highest assigned cursor; delegates to {@link EventJournal.latest}. */
  latest(): EventCursor
  /** Replay from the journal; delegates to {@link EventJournal.readAfter}. */
  readAfter(after: EventCursor, limit?: number): JournalReadResult
}

/**
 * Create a {@link LiveFeed} over `journal`. The journal remains the sole owner
 * of cursors and durability; the feed adds transient in-process fanout and
 * nothing else.
 */
export function createLiveFeed(journal: EventJournal): LiveFeed {
  const subscribers = new Set<(event: NormalizedEvent) => void>()

  /**
   * Fan `event` out to a SNAPSHOT of the subscriber set. Copying the set first
   * freezes membership for this fanout: a callback that adds or removes a
   * subscriber mid-flight cannot change who observes this event. Each call is
   * isolated in its own try/catch so a throwing subscriber never escapes the
   * fanout.
   */
  const fanout = (event: NormalizedEvent): void => {
    for (const onEvent of [...subscribers]) {
      try {
        onEvent(event)
      } catch (error) {
        // A throwing subscriber must never take down the fanout, corrupt the
        // journal, or block the feed. Log and move on so the remaining
        // subscribers still receive the event. (Failure-isolation pattern,
        // mirroring ../insights/engine.ts.)
        console.error('[live-feed] subscriber threw during fanout', error)
      }
    }
  }

  return {
    record: (event: UnsequencedEvent): NormalizedEvent => {
      const sequenced = journal.append(event)
      fanout(sequenced)
      return sequenced
    },
    subscribe: (onEvent: (event: NormalizedEvent) => void): (() => void) => {
      subscribers.add(onEvent)
      let unsubscribed = false
      return () => {
        // Idempotent: the second (and later) call is a no-op. The flag guards
        // against re-adding noise and makes the contract obvious to callers.
        if (unsubscribed) return
        unsubscribed = true
        subscribers.delete(onEvent)
      }
    },
    latest: (): EventCursor => journal.latest(),
    readAfter: (after: EventCursor, limit?: number): JournalReadResult =>
      journal.readAfter(after, limit)
  }
}
