// Live timeline connection: seeds from `timeline.read`, tails the SSE stream,
// and resyncs on a `gap` frame. Exposed to the app as a React context so every
// view (timeline, workers, review) folds the SAME event stream.
//
// Resilience: a phone driving a PC core over flaky wifi drops the SSE
// connection repeatedly. Rather than die (or let the browser hammer the core),
// the controller closes the dead EventSource itself and reopens it from the
// newest cursor it still holds, with exponential backoff (see `backoff.ts`).
// When the core answers a query with `429` it backs off by the parsed
// `Retry-After` instead and reports it so the shell can show a retry banner —
// the held timeline is never wiped on a rate-limit or a dropped stream.

import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { applyFrame, initialTimeline } from '@ops/web-client-core'
import type { EventStreamFrame } from '@ops/api-contract'
import type { JournalReadResult } from '@ops/events'
import type { TimelineState } from '@ops/web-client-core'
import type { CoreClient } from '../api/client'
import { RateLimitError } from '../api/client'
import { mergeRead } from '../viewmodel/timelineMerge'
import { BACKOFF_SCHEDULE_MS, backoffDelay } from './backoff'

/** The most events the client retains in memory; older ones drop from the view. */
const MAX_EVENTS = 400

/**
 * Coarse lifecycle of the live connection, surfaced for the status chip.
 * - `connecting`: seeding the initial page.
 * - `live`: stream open and folding events.
 * - `resyncing`: handling a `gap` (re-querying the journal).
 * - `reconnecting`: stream dropped / query failed — backing off to retry.
 * - `offline`: the drop has persisted into the capped-backoff range (the core
 *   is likely genuinely unreachable; we still keep retrying).
 */
export type TimelineStatus = 'connecting' | 'live' | 'resyncing' | 'reconnecting' | 'offline'

/**
 * The three-state connection health the status chip shows, derived from the
 * finer {@link TimelineStatus}. Pure so it is assertable without a DOM.
 */
export type ConnectionStatus = 'connected' | 'reconnecting' | 'offline'

export function connectionStatusOf(status: TimelineStatus): ConnectionStatus {
  if (status === 'live' || status === 'resyncing') return 'connected'
  if (status === 'connecting' || status === 'reconnecting') return 'reconnecting'
  return 'offline'
}

/** A transient rate-limit signal for the retry banner. */
export interface RateLimitState {
  /** Seconds the core asked us to wait (for the banner copy). */
  retryAfter: number
  /** Epoch ms after which the banner should hide. */
  expiresAt: number
}

export interface TimelineHandle {
  /** Tear down the stream, cancel any pending reconnect, ignore later callbacks. */
  stop: () => void
}

/**
 * Owns one timeline connection's lifecycle. Pure side-effecting controller (no
 * React) so the wiring is explicit: seed from the journal, open the SSE stream
 * at the seeded cursor, and on a `gap` frame re-query + reconnect. On any drop
 * or failure it backs off and resumes from the newest cursor it holds, so a
 * flaky link heals without losing the already-folded timeline.
 *
 * @param onState     new folded timeline state
 * @param onStatus    connection lifecycle changes
 * @param onRateLimit fired when a `429` is observed, carrying the wait in seconds
 */
export function startTimeline(
  client: CoreClient,
  onState: (state: TimelineState) => void,
  onStatus: (status: TimelineStatus) => void,
  onRateLimit?: (retryAfter: number) => void
): TimelineHandle {
  let stopped = false
  let es: EventSource | null = null
  let state: TimelineState = initialTimeline()
  let resyncing = false
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectAttempt = 0
  /** Epoch ms until which reconnects are paused because of a `429`. */
  let rateLimitUntil = 0

  const emit = (): void => {
    if (!stopped) onState(state)
  }

  function clearReconnect(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  /** Record a rate-limit and notify the shell so it can show a retry banner. */
  function noteRateLimit(retryAfter: number): void {
    const secs = Math.max(1, retryAfter)
    rateLimitUntil = Date.now() + secs * 1000
    if (!stopped) onRateLimit?.(secs)
  }

  /**
   * Pause, then run `next`. The delay is the core's `Retry-After` window when
   * one is active, otherwise the exponential backoff schedule. A short drop
   * surfaces as `reconnecting`; a drop that has persisted into the capped range
   * surfaces as `offline` so the operator knows the core is likely gone (the
   * controller still keeps retrying). The held timeline is left intact — only
   * the stream is reopened.
   */
  function scheduleReconnect(next: () => void): void {
    if (stopped) return
    es?.close()
    es = null
    clearReconnect()
    const now = Date.now()
    const rateLimited = rateLimitUntil > now
    let delay: number
    let status: TimelineStatus
    if (rateLimited) {
      // A deliberate, short backoff the core asked for — not a real outage.
      delay = rateLimitUntil - now
      status = 'reconnecting'
    } else {
      delay = backoffDelay(reconnectAttempt)
      status = reconnectAttempt >= BACKOFF_SCHEDULE_MS.length ? 'offline' : 'reconnecting'
      reconnectAttempt += 1
    }
    onStatus(status)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      if (!stopped) next()
    }, delay)
  }

  /**
   * Open (or reopen) the SSE stream at `after`. When the client has a token,
   * mint a FRESH single-use ticket first (tickets are consumed on connect, so
   * every (re)connect needs its own) and pass it to the events URL. A failed
   * ticket mint is treated exactly like a dropped connection — back off and
   * retry — never as an unhandled rejection, never with a stale/reused ticket.
   * With no token (loopback) the stream opens bare.
   */
  async function openStream(after: number): Promise<void> {
    if (stopped) return
    es?.close()
    let ticket: string | undefined
    if (client.apiToken) {
      try {
        ticket = (await client.sseTicket()).ticket
      } catch (err) {
        if (stopped) return
        if (err instanceof RateLimitError) noteRateLimit(err.retryAfter)
        scheduleReconnect(() => void openStream(after))
        return
      }
      if (stopped) return
    }
    es = new EventSource(client.eventsStreamUrl(after, ticket))
    // `open` fires once the HTTP stream is genuinely established (a non-2xx,
    // e.g. a 429 on the SSE endpoint, fails the connection and never opens) —
    // so the chip only claims `live` once a frame can actually flow.
    es.onopen = (): void => {
      reconnectAttempt = 0
      onStatus('live')
    }
    es.onmessage = (msg: MessageEvent<string>): void => {
      let frame: EventStreamFrame
      try {
        frame = JSON.parse(msg.data) as EventStreamFrame
      } catch {
        return // Malformed frame; the cursor is the authority, so skip it.
      }
      state = applyFrame(state, frame, { max: MAX_EVENTS })
      emit()
      if (frame.type === 'gap' && !resyncing) {
        void resync(frame.earliestAvailable)
      }
    }
    es.onerror = (): void => {
      // Take over from the browser's own auto-reconnect: close and back off.
      es?.close()
      es = null
      if (!resyncing) scheduleReconnect(() => void openStream(state.cursor))
    }
  }

  async function resync(from: number): Promise<void> {
    if (stopped || resyncing) return
    resyncing = true
    onStatus('resyncing')
    try {
      const read: JournalReadResult = await client.query({
        name: 'timeline.read',
        afterCursor: from,
        limit: MAX_EVENTS
      })
      if (stopped) return
      state = mergeRead(state, read)
      emit()
      resyncing = false
      reconnectAttempt = 0
      void openStream(state.cursor)
    } catch (err) {
      resyncing = false
      if (stopped) return
      if (err instanceof RateLimitError) noteRateLimit(err.retryAfter)
      scheduleReconnect(() => void resync(from))
    }
  }

  async function seed(): Promise<void> {
    onStatus('connecting')
    try {
      const read = await client.query({
        name: 'timeline.read',
        afterCursor: 0,
        limit: MAX_EVENTS
      })
      if (stopped) return
      // Seed from the page directly; a gap at cursor 0 is just rotated
      // history, not a resync trigger — there is nothing earlier to fetch.
      state = {
        events: read.events,
        cursor: read.latestCursor,
        needsResyncFrom: null
      }
      emit()
      void openStream(state.cursor)
    } catch (err) {
      if (stopped) return
      if (err instanceof RateLimitError) noteRateLimit(err.retryAfter)
      // Core unreachable at seed time — back off and try to seed again rather
      // than giving up (the handshake succeeded, so this is likely a blip).
      scheduleReconnect(() => void seed())
    }
  }

  void seed()

  return {
    stop(): void {
      stopped = true
      clearReconnect()
      es?.close()
      es = null
    }
  }
}

interface TimelineContextValue {
  state: TimelineState
  status: TimelineStatus
  /** Active rate-limit signal for the retry banner, or null when healthy. */
  rateLimit: RateLimitState | null
  /** Dismiss the rate-limit banner early (clears the signal). */
  clearRateLimit: () => void
}

const TimelineContext = createContext<TimelineContextValue | null>(null)

/** Provides the single shared timeline stream to the app tree. */
export function TimelineProvider({
  client,
  children
}: {
  client: CoreClient
  children: ReactNode
}): JSX.Element {
  const [state, setState] = useState<TimelineState>(initialTimeline)
  const [status, setStatus] = useState<TimelineStatus>('connecting')
  const [rateLimit, setRateLimit] = useState<RateLimitState | null>(null)

  const clearRateLimit = useCallback(() => setRateLimit(null), [])

  useEffect(() => {
    setState(initialTimeline())
    setStatus('connecting')
    setRateLimit(null)
    const handle = startTimeline(
      client,
      setState,
      setStatus,
      (retryAfter) => setRateLimit({ retryAfter, expiresAt: Date.now() + retryAfter * 1000 })
    )
    return () => handle.stop()
  }, [client])

  return (
    <TimelineContext.Provider value={{ state, status, rateLimit, clearRateLimit }}>
      {children}
    </TimelineContext.Provider>
  )
}

/** Read the shared live timeline. Throws if used outside the provider. */
export function useTimeline(): TimelineContextValue {
  const ctx = useContext(TimelineContext)
  if (!ctx) throw new Error('useTimeline must be used within a TimelineProvider')
  return ctx
}
