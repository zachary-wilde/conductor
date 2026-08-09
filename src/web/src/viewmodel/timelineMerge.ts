// Pure view-model: merge a `timeline.read` page into the live-folded state.
//
// The SSE stream folds events in arrival order with cursor-dedup, but a `gap`
// frame means the journal rotated past the client's cursor — the live stream
// alone can no longer fill the hole. The client re-queries `timeline.read` from
// the gap's `earliestAvailable` and folds the page back in here: events the
// client already had are kept, the page's events fill the gap, the result is
// re-sorted by cursor, and the resync flag is cleared.
//
// Pure and synchronous so it is trivially unit-testable.

import type { JournalReadResult, NormalizedEvent } from '@ops/events'
import type { TimelineState } from '@ops/web-client-core'

/**
 * Fold a journal read page into a timeline state. Existing events win on a
 * cursor collision EXCEPT the page's copy (a re-query may carry richer detail);
 * the merged cursor is the max of both so the client never regresses. The
 * returned state is always clear of `needsResyncFrom`.
 */
export function mergeRead(state: TimelineState, read: JournalReadResult): TimelineState {
  const byCursor = new Map<number, NormalizedEvent>()
  for (const ev of state.events) byCursor.set(ev.cursor, ev)
  // The page is authoritative on a collision (it is the freshest re-query).
  for (const ev of read.events) byCursor.set(ev.cursor, ev)
  const events = [...byCursor.values()].sort((a, b) => a.cursor - b.cursor)
  return {
    events,
    cursor: Math.max(state.cursor, read.latestCursor),
    needsResyncFrom: null
  }
}
