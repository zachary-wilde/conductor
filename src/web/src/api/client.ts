// Network layer for the operator web UI.
//
// This is the ONLY module in the web app that touches the network for
// request/response traffic. It wraps the three core endpoints (handshake,
// command, query) behind a small typed client and builds the SSE events URL the
// timeline controller opens. The pure request/handshake helpers come from
// `web-client-core`, so the wire shapes can never drift between client and
// server: every POST body is built by `commandRequest` / `queryRequest` and
// every handshake is validated by `parseHandshake`.
//
// Auth (Release B): the client carries an access token and sends it as an
// `Authorization: Bearer <token>` header on every request when one is set.
// The SSE stream cannot carry headers (EventSource limitation), so instead of
// leaking the bearer in the URL the client mints a SHORT-LIVED, SINGLE-USE
// ticket via `POST /api/sse-ticket` (this module) and opens the stream as
// `/api/events?after=<cursor>&ticket=<ticket>` (timeline controller). Each
// (re)connect fetches a FRESH ticket — they are consumed on stream open and
// never reused. When no token is configured (loopback desktop/dev) the stream
// opens with neither ticket nor auth header; the server leaves loopback open.
// Where the base URL + token come from is decided by `state/connection.ts`;
// this module just uses what it is handed.

import {
  commandRequest,
  parseHandshake,
  queryRequest
} from '@ops/web-client-core'
import { API_VERSION } from '@ops/api-contract'
import type {
  ClientCommand,
  ClientQuery,
  CommandResult,
  CoreHandshake,
  QueryResults
} from '@ops/api-contract'
import type { EventCursor } from '@ops/events'

/**
 * The store-schema version the REAL core reports. It is a private constant in
 * `operations/core.ts` (`STORE_SCHEMA_VERSION = 2`); it is mirrored here rather
 * than imported so the web bundle never reaches into node-only modules. Bump
 * this in lockstep with the core if the persisted store shape ever changes.
 */
export const STORE_SCHEMA_VERSION = 2

/** The local build's version pair, used to gate mutation via `isCompatible`. */
export const LOCAL_BUILD = {
  apiVersion: API_VERSION,
  storeSchemaVersion: STORE_SCHEMA_VERSION
} as const

/** A structured query failure carrying the core's safe `{code,message}`. */
export class CoreQueryError extends Error {
  constructor(
    readonly queryName: string,
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'CoreQueryError'
  }
}

/** A structured command failure carrying the core's safe `{code,message}`. */
export class CoreCommandError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'CoreCommandError'
  }
}
/**
 * Seconds to wait before retrying when the core rate-limits (HTTP 429) but
 * omits a usable `Retry-After` value. The server sends delta-seconds, so this
 * is only a defensive fallback.
 */
export const DEFAULT_RETRY_AFTER_SECONDS = 5

/**
 * Structured rate-limit signal. Thrown from any request (handshake, command,
 * query) when the core answers `429`. Carries the parsed `Retry-After` so the
 * caller can back off precisely instead of guessing, and so the timeline can
 * show a "retrying in Ns" banner.
 */
export class RateLimitError extends Error {
  constructor(readonly retryAfter: number) {
    super(`rate limited (retry after ${retryAfter}s)`)
    this.name = 'RateLimitError'
  }
}

/**
 * Parse an HTTP `Retry-After` header into whole seconds from now. Accepts a
 * delta-seconds value (`"30"`) or an HTTP-date; returns `null` when the header
 * is missing or unparseable so the caller can apply {@link DEFAULT_RETRY_AFTER_SECONDS}.
 * Pure (modulo `Date.now` for the date form) and unit-tested.
 */
export function parseRetryAfter(header: string | null, now: number = Date.now()): number | null {
  if (!header) return null
  const value = header.trim()
  if (/^\d+$/.test(value)) {
    const secs = Number(value)
    return Number.isFinite(secs) ? Math.max(0, Math.floor(secs)) : null
  }
  // Not a delta-seconds integer. Try an HTTP-date, but reject bare signed
  // numbers first: `Date.parse` is lenient enough to accept "-5", which would
  // otherwise masquerade as a zero-second retry.
  if (/^-?\d+$/.test(value)) return null
  const date = Date.parse(value)
  if (!Number.isNaN(date)) return Math.max(0, Math.ceil((date - now) / 1000))
  return null
}

/**
 * Typed loopback client for the api-contract surface. Stateless beyond the base
 * URL + token: every call is an independent `fetch`, so retries and reconnects
 * are the caller's concern (and trivial — just call again with a fresh
 * `operationId`). The token is sent on every request when non-empty.
 */
export class CoreClient {
  constructor(readonly apiBase: string, readonly apiToken: string = '') {}

  /** `Authorization: Bearer <token>` when a token is set; nothing otherwise. */
  private authHeaders(): Record<string, string> {
    return this.apiToken ? { authorization: `Bearer ${this.apiToken}` } : {}
  }

  /**
   * `GET /api/handshake`, validated and typed. Throws on a non-2xx (the core
   * returns 401 with a safe `{code,message}` when a token is required but
   * missing/wrong); the shell treats any thrown handshake exactly like a failed
   * connection and shows the Connect screen.
   */
  async handshake(): Promise<CoreHandshake> {
    const res = await fetch(this.apiBase + '/api/handshake', {
      method: 'GET',
      headers: this.authHeaders()
    })
    if (res.status === 429) {
      throw new RateLimitError(
        parseRetryAfter(res.headers.get('retry-after')) ?? DEFAULT_RETRY_AFTER_SECONDS
      )
    }
    if (!res.ok) {
      const err = await safeError(res)
      throw new Error(`handshake failed (HTTP ${res.status}): ${err.message}`)
    }
    return parseHandshake(await res.json())
  }

  /**
   * `POST /api/command`. The body is built by `commandRequest`. The core always
   * answers 200 with a `CommandResult` (it may be `ok:false` with a safe error
   * for a refused command); a non-2xx means a transport/protocol fault and is
   * thrown as {@link CoreCommandError}.
   */
  async command<T = unknown>(cmd: ClientCommand): Promise<CommandResult<T>> {
    const desc = commandRequest(cmd)
    const res = await fetch(this.apiBase + desc.path, {
      method: desc.method,
      headers: { 'content-type': 'application/json', ...this.authHeaders() },
      body: desc.body
    })
    if (res.status === 429) {
      throw new RateLimitError(
        parseRetryAfter(res.headers.get('retry-after')) ?? DEFAULT_RETRY_AFTER_SECONDS
      )
    }
    if (!res.ok) {
      const err = await safeError(res)
      throw new CoreCommandError(err.code, err.message)
    }
    return (await res.json()) as CommandResult<T>
  }

  /**
   * `POST /api/query`. The body is built by `queryRequest`; the core answers
   * 200 with the bare result value for the query name. A non-2xx is thrown as
   * {@link CoreQueryError}.
   */
  async query<Q extends ClientQuery>(q: Q): Promise<QueryResults[Q['name']]> {
    const desc = queryRequest(q)
    const res = await fetch(this.apiBase + desc.path, {
      method: desc.method,
      headers: { 'content-type': 'application/json', ...this.authHeaders() },
      body: desc.body
    })
    if (res.status === 429) {
      throw new RateLimitError(
        parseRetryAfter(res.headers.get('retry-after')) ?? DEFAULT_RETRY_AFTER_SECONDS
      )
    }
    if (!res.ok) {
      const err = await safeError(res)
      throw new CoreQueryError(q.name, err.code, err.message)
    }
    return (await res.json()) as QueryResults[Q['name']]
  }

  /**
   * `POST /api/sse-ticket` → `{ticket, ttlMs}`. The ticket is short-lived and
   * single-use: it authenticates exactly one stream open and is consumed on
   * connect, so the timeline controller MUST fetch a fresh one before EVERY
   * (re)connect — never reuse it. Only meaningful when a token is set; the
   * bearer header rides along via {@link authHeaders}. Throws on a non-2xx
   * (`RateLimitError` on a 429, `CoreQueryError` otherwise) like the other
   * methods, so a failed mint surfaces upstream as a connection failure.
   */
  async sseTicket(): Promise<{ ticket: string; ttlMs: number }> {
    const res = await fetch(this.apiBase + '/api/sse-ticket', {
      method: 'POST',
      headers: this.authHeaders()
    })
    if (res.status === 429) {
      throw new RateLimitError(
        parseRetryAfter(res.headers.get('retry-after')) ?? DEFAULT_RETRY_AFTER_SECONDS
      )
    }
    if (!res.ok) {
      const err = await safeError(res)
      throw new CoreQueryError('sse-ticket', err.code, err.message)
    }
    const body = (await res.json()) as { ticket?: unknown; ttlMs?: unknown }
    if (typeof body.ticket !== 'string' || typeof body.ttlMs !== 'number') {
      throw new CoreQueryError('sse-ticket', 'malformed-ticket', 'sse-ticket response was malformed')
    }
    return { ticket: body.ticket, ttlMs: body.ttlMs }
  }

  /**
   * The SSE events URL. `EventSource` cannot set headers, so when the caller
   * has minted a ticket (only when a token is set) it rides as a `ticket`
   * query param (URL-encoded, single-use). It is omitted entirely otherwise so
   * an unauthenticated core never sees a stray param. The bearer itself NEVER
   * appears in the URL.
   */
  eventsStreamUrl(after: EventCursor, ticket?: string): string {
    const base = `${this.apiBase}/api/events?after=${after}`
    return ticket ? `${base}&ticket=${encodeURIComponent(ticket)}` : base
  }
}

/** Extract the core's safe `{code,message}` from a failed response, if present. */
async function safeError(res: Response): Promise<{ code: string; message: string }> {
  try {
    const body = (await res.json()) as { error?: { code: string; message: string } }
    if (body?.error) return { code: body.error.code, message: body.error.message }
  } catch {
    // Non-JSON or empty body — fall through to the generic HTTP status.
  }
  return { code: `http-${res.status}`, message: `request failed (HTTP ${res.status})` }
}
