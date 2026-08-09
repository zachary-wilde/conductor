import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { connectionStatusOf, startTimeline } from './timeline'
import type { ConnectionStatus, TimelineStatus } from './timeline'
import { CoreClient } from '../api/client'
import type { JournalReadResult } from '@ops/events'
import type { QueryResults } from '@ops/api-contract'

const CASES: Array<[TimelineStatus, ConnectionStatus]> = [
  ['live', 'connected'],
  ['resyncing', 'connected'],
  ['connecting', 'reconnecting'],
  ['reconnecting', 'reconnecting'],
  ['offline', 'offline']
]

describe('connectionStatusOf', () => {
  for (const [status, expected] of CASES) {
    it(`maps ${status} → ${expected}`, () => {
      expect(connectionStatusOf(status)).toBe(expected)
    })
  }
})

/** A ticket the mocked `sseTicket` returns: the secret + its declared lifetime. */
interface SseTicket {
  ticket: string
  ttlMs: number
}

/** The procedure shape of `CoreClient.sseTicket`, named so the mock is typed. */
type SseTicketMint = () => Promise<SseTicket>

/**
 * Minimal EventSource stub: records every instance and lets tests fire its
 * callbacks (open/message/error) to drive the controller through connect /
 * drop / resync. The controller only reads `onopen`/`onmessage`/`onerror` and
 * calls `close()`, so that is all we implement.
 */
class FakeEventSource {
  static last: FakeEventSource | null = null
  static all: FakeEventSource[] = []
  readonly url: string
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  constructor(url: string) {
    this.url = url
    FakeEventSource.all.push(this)
    FakeEventSource.last = this
  }
  close(): void {
    this.closed = true
  }
}

const globalWithES = globalThis as { EventSource?: unknown }
const originalEventSource = globalWithES.EventSource

/** Handle to the `sseTicket` mock swapped onto a real `CoreClient` for a test. */
interface MockClient {
  client: CoreClient
  sseTicket: MockInstance<SseTicketMint>
}

/**
 * Build a REAL `CoreClient` (so `apiToken` + `eventsStreamUrl` are the genuine
 * implementation) with `query` and `sseTicket` swapped for controllable mocks.
 * `tickets` is the queue of tickets `sseTicket` hands out, in call order, so a
 * test can assert a FRESH ticket per (re)connect; `sseTicket` overrides the
 * queue entirely when the mint needs to fail/repair mid-run.
 */
function makeClient(token: string, tickets: string[], sseTicket?: SseTicketMint): MockClient {
  const client = new CoreClient('http://core:47615', token)
  let n = 0
  const fallbackMint: SseTicketMint = async () => {
    const ticket = tickets[n++] ?? `fallback-${n}`
    return { ticket, ttlMs: 30000 }
  }
  const ticketMock = vi.fn(sseTicket ?? fallbackMint)
  const read: JournalReadResult = { events: [], latestCursor: 0, gap: null }
  const queryMock = vi.fn(async () => read as QueryResults['timeline.read'])
  // Both are public on CoreClient; swap them on this instance.
  Object.assign(client, { sseTicket: ticketMock, query: queryMock })
  return { client, sseTicket: ticketMock }
}

beforeEach(() => {
  vi.useFakeTimers()
  globalWithES.EventSource = FakeEventSource
  FakeEventSource.last = null
  FakeEventSource.all = []
})

afterEach(() => {
  vi.useRealTimers()
  if (originalEventSource === undefined) delete globalWithES.EventSource
  else globalWithES.EventSource = originalEventSource
})

describe('startTimeline — SSE ticket per (re)connect', () => {
  it('mints a fresh ticket before opening the stream when a token is set', async () => {
    const { client, sseTicket } = makeClient('tok', ['T1'])
    const statuses: TimelineStatus[] = []
    const handle = startTimeline(client, () => {}, (s) => statuses.push(s))
    // seed() → query → openStream() → sseTicket() → new EventSource (microtasks).
    await vi.advanceTimersByTimeAsync(0)

    expect(sseTicket.mock.calls).toHaveLength(1)
    expect(FakeEventSource.last!.url).toBe('http://core:47615/api/events?after=0&ticket=T1')
    handle.stop()
  })

  it('requests a FRESH ticket again after a dropped stream', async () => {
    const { client, sseTicket } = makeClient('tok', ['T1', 'T2'])
    const handle = startTimeline(client, () => {}, () => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(FakeEventSource.last!.url).toContain('ticket=T1')
    const firstES = FakeEventSource.last!

    // Simulate a dropped connection; the controller backs off then reopens.
    firstES.onerror!()
    await vi.advanceTimersByTimeAsync(2000) // backoffDelay(0) ≈ 1s ±10% jitter

    expect(sseTicket.mock.calls).toHaveLength(2)
    expect(FakeEventSource.last!.url).toContain('ticket=T2')
    expect(FakeEventSource.last).not.toBe(firstES) // a NEW EventSource
    handle.stop()
  })

  it('never mints a ticket and opens bare when there is no token', async () => {
    const { client, sseTicket } = makeClient('', [])
    const handle = startTimeline(client, () => {}, () => {})
    await vi.advanceTimersByTimeAsync(0)

    expect(sseTicket.mock.calls).toHaveLength(0)
    expect(FakeEventSource.last!.url).toBe('http://core:47615/api/events?after=0')
    handle.stop()
  })

  it('treats a failed ticket mint as a connection failure (back off + retry)', async () => {
    let mintFails = true
    const { client, sseTicket } = makeClient('tok', [], async () => {
      if (mintFails) throw new Error('mint-down')
      return { ticket: 'T-retry', ttlMs: 30000 }
    })
    const handle = startTimeline(client, () => {}, () => {})
    await vi.advanceTimersByTimeAsync(0)
    // First mint failed → no stream opened, a reconnect is scheduled.
    expect(FakeEventSource.all).toHaveLength(0)
    expect(sseTicket.mock.calls).toHaveLength(1)

    mintFails = false
    await vi.advanceTimersByTimeAsync(2000)
    // Retried mint succeeded → stream opened with the fresh ticket.
    expect(sseTicket.mock.calls).toHaveLength(2)
    expect(FakeEventSource.last!.url).toContain('ticket=T-retry')
    handle.stop()
  })
})
