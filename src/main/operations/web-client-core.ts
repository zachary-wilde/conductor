// Pure, browser-agnostic client logic for the operator web UI (Release B).
//
// The web shell performs the actual network I/O (fetch, EventSource, timers);
// this module is the brain it shares with the desktop renderer: it builds the
// request descriptors the shell sends, parses the opening handshake, decides
// whether a core is safe to mutate against, and reduces the SSE frame stream
// into an ordered, deduped timeline. Nothing here touches the DOM, the network,
// or the clock, so it is identical whether it runs in a browser tab, a web
// worker, or (later) a Capacitor-wrapped Android shell driving the Windows core
// remotely.
//
// Both this module and the server slice depend only on `./api-contract` and
// `./events`; they never import each other.

import type {
  ClientCommand,
  ClientQuery,
  CoreHandshake,
  EventStreamFrame
} from './api-contract'
import type { EventCursor, NormalizedEvent } from './events'

/**
 * The shape of an HTTP request the UI shell performs. `body` is the already
 * serialized JSON string for POST requests (the empty string when none); the
 * shell adds headers and auth without re-encoding.
 */
export interface HttpRequestDescriptor {
  method: 'GET' | 'POST'
  path: string
  body: string
}

/**
 * Build the POST descriptor for a mutating command. The body is the JSON-encoded
 * `ClientCommand`; the shell POSTs it verbatim. Round-tripping the body yields
 * the original command.
 */
export function commandRequest(cmd: ClientCommand): HttpRequestDescriptor {
  return { method: 'POST', path: '/api/command', body: JSON.stringify(cmd) }
}

/**
 * Build the POST descriptor for a read query. The body is the JSON-encoded
 * `ClientQuery`; round-tripping it yields the original query.
 */
export function queryRequest(q: ClientQuery): HttpRequestDescriptor {
  return { method: 'POST', path: '/api/query', body: JSON.stringify(q) }
}

/**
 * The SSE stream path the shell opens, replaying everything strictly after
 * `afterCursor`. The cursor is the only ordering authority, so it is the entire
 * query: `/api/events?after=<n>`.
 */
export function eventsPath(afterCursor: EventCursor): string {
  return `/api/events?after=${afterCursor}`
}

/**
 * Parse and validate the core's opening handshake from an untyped source (a
 * parsed JSON body). Throws on any malformed or wrong-typed field so the shell
 * never feeds a half-shaped handshake to `isCompatible`.
 */
export function parseHandshake(raw: unknown): CoreHandshake {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('handshake: expected an object')
  }
  const o = raw as Record<string, unknown>
  const { coreVersion, apiVersion, storeSchemaVersion, capabilities, cursor } = o

  if (typeof coreVersion !== 'string') {
    throw new Error('handshake.coreVersion: expected string')
  }
  if (typeof apiVersion !== 'number' || !Number.isFinite(apiVersion)) {
    throw new Error('handshake.apiVersion: expected finite number')
  }
  if (typeof storeSchemaVersion !== 'number' || !Number.isFinite(storeSchemaVersion)) {
    throw new Error('handshake.storeSchemaVersion: expected finite number')
  }
  if (
    !Array.isArray(capabilities) ||
    capabilities.some((c) => typeof c !== 'string')
  ) {
    throw new Error('handshake.capabilities: expected string[]')
  }
  if (typeof cursor !== 'number' || !Number.isFinite(cursor)) {
    throw new Error('handshake.cursor: expected finite number')
  }

  return { coreVersion, apiVersion, storeSchemaVersion, capabilities, cursor }
}

/**
 * Decide whether a core is safe to mutate against. Compatibility requires an
 * EXACT match on both `apiVersion` (the wire protocol) and `storeSchemaVersion`
 * (the persisted shape): a client newer or older than the core in either axis
 * must read only and refuse to send commands, since a near-miss version could
 * corrupt state rather than fail loudly.
 */
export function isCompatible(
  local: { apiVersion: number; storeSchemaVersion: number },
  hs: CoreHandshake
): boolean {
  return (
    local.apiVersion === hs.apiVersion &&
    local.storeSchemaVersion === hs.storeSchemaVersion
  )
}

/**
 * The reduced state of the live timeline. Events are kept ordered by `cursor`
 * ascending and deduped by cursor. `cursor` is the highest cursor applied so
 * far (0 before any event). `needsResyncFrom` is set when a `gap` frame arrived:
 * the journal rotated past the client's cursor, so the UI must re-query from
 * that cursor and call `clearResync`.
 */
export interface TimelineState {
  events: NormalizedEvent[]
  cursor: EventCursor
  needsResyncFrom: EventCursor | null
}

/** A fresh timeline: no events, cursor 0 (before the first sequenced event), no resync pending. */
export function initialTimeline(): TimelineState {
  return { events: [], cursor: 0, needsResyncFrom: null }
}

/**
 * Fold one SSE frame into the timeline, returning a NEW state and never
 * mutating the input.
 *
 * An `event` frame whose cursor is greater than the current cursor is appended
 * (in arrival order, which the monotonic cursor keeps ascending) and the cursor
 * advances to it; an event whose cursor is `<=` the current cursor is a
 * duplicate or stale replay and is ignored — no duplicate, no cursor regression.
 * When `opts.max` is set, only the `max` most-recent events are retained after
 * the fold.
 *
 * A `gap` frame leaves the events untouched but sets `needsResyncFrom` to the
 * journal's `earliestAvailable` cursor; the UI then reconnects/queries from
 * there and clears the flag.
 */
export function applyFrame(
  state: TimelineState,
  frame: EventStreamFrame,
  opts: { max?: number } = {}
): TimelineState {
  if (frame.type === 'gap') {
    return {
      events: state.events,
      cursor: state.cursor,
      needsResyncFrom: frame.earliestAvailable
    }
  }

  const ev = frame.event

  // Duplicate or stale replay: ignore. A new object (sharing the event array
  // reference) is returned so callers never observe mutation, but nothing moves.
  if (ev.cursor <= state.cursor) {
    return {
      events: state.events,
      cursor: state.cursor,
      needsResyncFrom: state.needsResyncFrom
    }
  }

  let events = state.events.concat(ev)
  if (opts.max !== undefined && events.length > opts.max) {
    // Keep the most-recent `max`: drop from the front.
    events = events.slice(events.length - opts.max)
  }

  return {
    events,
    cursor: ev.cursor,
    needsResyncFrom: state.needsResyncFrom
  }
}

/**
 * Clear the resync flag after the UI has re-queried from `needsResyncFrom` and
 * resumed the live stream. Events and cursor are carried over unchanged.
 */
export function clearResync(state: TimelineState): TimelineState {
  return {
    events: state.events,
    cursor: state.cursor,
    needsResyncFrom: null
  }
}
