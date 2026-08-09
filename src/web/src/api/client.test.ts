import { afterEach, describe, expect, it } from 'vitest'
import type { ClientQuery, CommandResult, CoreHandshake } from '@ops/api-contract'
import type { JournalReadResult } from '@ops/events'
import {
  CoreClient,
  CoreQueryError,
  DEFAULT_RETRY_AFTER_SECONDS,
  RateLimitError,
  parseRetryAfter
} from './client'
import { workerControl } from '../viewmodel/commands'

const HANDSHAKE: CoreHandshake = {
  coreVersion: '1.0.0',
  apiVersion: 1,
  storeSchemaVersion: 2,
  capabilities: [],
  cursor: 0
}

interface CapturedCall {
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

const originalFetch = global.fetch

/**
 * Replace `global.fetch` with a recorder that answers the same canned response
 * for every call and captures the request line + headers so the auth contract
 * (Bearer header present only when a token is set) is assertable. Response
 * `headers` (e.g. a `Retry-After`) are surfaced via a case-insensitive getter.
 */
function recordFetch(response: {
  ok: boolean
  status: number
  body: unknown
  headers?: Record<string, string>
}): { calls: CapturedCall[] } {
  const calls: CapturedCall[] = []
  global.fetch = (async (url: URL | string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: String(init?.body ?? '')
    })
    const lower: Record<string, string> = {}
    for (const [k, v] of Object.entries(response.headers ?? {})) lower[k.toLowerCase()] = v
    return {
      ok: response.ok,
      status: response.status,
      json: async () => response.body,
      headers: { get: (name: string) => lower[name.toLowerCase()] ?? null }
    } as unknown as Response
  }) as typeof fetch
  return { calls }
}

afterEach(() => {
  global.fetch = originalFetch
})

describe('handshake — Authorization header', () => {
  it('sends Bearer token when a token is set', async () => {
    const { calls } = recordFetch({ ok: true, status: 200, body: HANDSHAKE })
    await new CoreClient('http://core:47615', 'pairing-tok').handshake()
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('http://core:47615/api/handshake')
    expect(calls[0].headers.authorization).toBe('Bearer pairing-tok')
  })

  it('omits the Authorization header when the token is empty', async () => {
    const { calls } = recordFetch({ ok: true, status: 200, body: HANDSHAKE })
    await new CoreClient('http://core:47615', '').handshake()
    expect(calls[0].headers.authorization).toBeUndefined()
  })
})

describe('command — content-type + Authorization', () => {
  const ok: CommandResult = { ok: true, operationId: 'op-1', deduplicated: false }
  const cmd = workerControl('w1', 'pause', { operationId: 'op-1' })

  it('sends both content-type and Authorization when a token is set', async () => {
    const { calls } = recordFetch({ ok: true, status: 200, body: ok })
    await new CoreClient('http://core:47615', 'tok').command(cmd)
    expect(calls[0].url).toBe('http://core:47615/api/command')
    expect(calls[0].method).toBe('POST')
    expect(calls[0].headers['content-type']).toBe('application/json')
    expect(calls[0].headers.authorization).toBe('Bearer tok')
  })

  it('omits Authorization when the token is empty', async () => {
    const { calls } = recordFetch({ ok: true, status: 200, body: ok })
    await new CoreClient('http://core:47615', '').command(cmd)
    expect(calls[0].headers['content-type']).toBe('application/json')
    expect(calls[0].headers.authorization).toBeUndefined()
  })
})

describe('query — Authorization + 401 handling', () => {
  const page: JournalReadResult = { events: [], latestCursor: 0, gap: null }

  it('sends Authorization when a token is set', async () => {
    const { calls } = recordFetch({ ok: true, status: 200, body: page })
    const q: ClientQuery = { name: 'timeline.read', afterCursor: 0, limit: 5 }
    await new CoreClient('http://core:47615', 'tok').query(q)
    expect(calls[0].headers.authorization).toBe('Bearer tok')
  })

  it('throws CoreQueryError carrying the safe code on a 401', async () => {
    recordFetch({
      ok: false,
      status: 401,
      body: { error: { code: 'unauthorized', message: 'token required' } }
    })
    const q: ClientQuery = { name: 'timeline.read', afterCursor: 0 }
    await expect(new CoreClient('http://core:47615', 'wrong').query(q)).rejects.toMatchObject({
      name: 'CoreQueryError',
      queryName: 'timeline.read',
      code: 'unauthorized'
    })
  })
})
describe('eventsStreamUrl — SSE ticket param', () => {
  it('appends the ticket query param when a ticket is given', () => {
    expect(new CoreClient('http://core:47615', 'tok').eventsStreamUrl(5, 'abc')).toBe(
      'http://core:47615/api/events?after=5&ticket=abc'
    )
  })

  it('omits the ticket param when none is given (no token in the URL)', () => {
    expect(new CoreClient('http://core:47615', 'tok').eventsStreamUrl(5)).toBe(
      'http://core:47615/api/events?after=5'
    )
    expect(new CoreClient('http://core:47615', '').eventsStreamUrl(5)).toBe(
      'http://core:47615/api/events?after=5'
    )
  })

  it('never emits a token= param — the bearer stays out of the URL', () => {
    const url = new CoreClient('http://core:47615', 'sekret').eventsStreamUrl(7, 't1')
    expect(url).not.toContain('token=')
    expect(url).toContain('ticket=t1')
  })

  it('URL-encodes the ticket', () => {
    expect(new CoreClient('http://core:47615', 'tok').eventsStreamUrl(7, 'a b/c')).toBe(
      'http://core:47615/api/events?after=7&ticket=a%20b%2Fc'
    )
  })
})

describe('sseTicket — POST /api/sse-ticket', () => {
  it('posts with the bearer header and parses {ticket, ttlMs}', async () => {
    const { calls } = recordFetch({
      ok: true,
      status: 200,
      body: { ticket: 't1', ttlMs: 30000 }
    })
    const res = await new CoreClient('http://core:47615', 'tok').sseTicket()
    expect(res).toEqual({ ticket: 't1', ttlMs: 30000 })
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('POST')
    expect(calls[0].url).toBe('http://core:47615/api/sse-ticket')
    expect(calls[0].headers).toMatchObject({ authorization: 'Bearer tok' })
  })

  it('omits the bearer header when no token is set', async () => {
    const { calls } = recordFetch({
      ok: true,
      status: 200,
      body: { ticket: 't1', ttlMs: 30000 }
    })
    await new CoreClient('http://core:47615', '').sseTicket()
    expect(calls[0].headers).not.toHaveProperty('authorization')
  })

  it('throws CoreQueryError on a non-2xx', async () => {
    recordFetch({
      ok: false,
      status: 401,
      body: { error: { code: 'unauthorized', message: 'bad token' } }
    })
    await expect(new CoreClient('http://core:47615', 'tok').sseTicket()).rejects.toBeInstanceOf(
      CoreQueryError
    )
  })

  it('throws RateLimitError on a 429', async () => {
    recordFetch({
      ok: false,
      status: 429,
      body: { error: { code: 'rate-limited', message: 'slow down' } },
      headers: { 'Retry-After': '8' }
    })
    await expect(new CoreClient('http://core:47615', 'tok').sseTicket()).rejects.toMatchObject({
      name: 'RateLimitError',
      retryAfter: 8
    })
  })

  it('throws on a malformed body', async () => {
    recordFetch({ ok: true, status: 200, body: { oops: 1 } })
    await expect(new CoreClient('http://core:47615', 'tok').sseTicket()).rejects.toMatchObject({
      name: 'CoreQueryError',
      code: 'malformed-ticket'
    })
  })
})

describe('parseRetryAfter', () => {
  it('parses a delta-seconds value', () => {
    expect(parseRetryAfter('30')).toBe(30)
    expect(parseRetryAfter('0')).toBe(0)
  })

  it('returns null for a missing or empty header', () => {
    expect(parseRetryAfter(null)).toBeNull()
    expect(parseRetryAfter('')).toBeNull()
    expect(parseRetryAfter('   ')).toBeNull()
  })

  it('returns null for an unparseable value', () => {
    expect(parseRetryAfter('soon')).toBeNull()
    expect(parseRetryAfter('-5')).toBeNull()
  })

  it('parses an HTTP-date relative to `now`', () => {
    const now = Date.parse('2026-08-06T12:00:00Z')
    const header = new Date(now + 45_000).toUTCString()
    expect(parseRetryAfter(header, now)).toBe(45)
  })

  it('clamps a past HTTP-date to zero', () => {
    const now = Date.parse('2026-08-06T12:00:00Z')
    const header = new Date(now - 10_000).toUTCString()
    expect(parseRetryAfter(header, now)).toBe(0)
  })
})

describe('429 rate-limit detection', () => {
  it('throws RateLimitError carrying Retry-After on a 429 query', async () => {
    recordFetch({
      ok: false,
      status: 429,
      body: { error: { code: 'rate-limited', message: 'too many requests' } },
      headers: { 'Retry-After': '12' }
    })
    const q: ClientQuery = { name: 'timeline.read', afterCursor: 0 }
    await expect(new CoreClient('http://core:47615', 'tok').query(q)).rejects.toMatchObject({
      name: 'RateLimitError',
      retryAfter: 12
    })
  })

  it('falls back to the default when Retry-After is missing', async () => {
    recordFetch({
      ok: false,
      status: 429,
      body: { error: { code: 'rate-limited', message: 'too many requests' } }
    })
    const q: ClientQuery = { name: 'timeline.read', afterCursor: 0 }
    await expect(new CoreClient('http://core:47615', 'tok').query(q)).rejects.toMatchObject({
      name: 'RateLimitError',
      retryAfter: DEFAULT_RETRY_AFTER_SECONDS
    })
  })

  it('detects 429 on command too', async () => {
    recordFetch({
      ok: false,
      status: 429,
      body: { error: { code: 'rate-limited', message: 'too many requests' } },
      headers: { 'Retry-After': '3' }
    })
    await expect(
      new CoreClient('http://core:47615', 'tok').command(workerControl('w', 'stop'))
    ).rejects.toBeInstanceOf(RateLimitError)
  })
})
