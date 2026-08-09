// Loopback HTTP + Server-Sent Events transport for the Operations Core.
//
// Release B's responsive web client (and, later, a Capacitor-wrapped Android
// shell) drives the Windows core through exactly the api-contract surface.
// This module is the transport ONLY: it owns request routing, JSON body
// framing, the SSE frame wire format, and disconnect bookkeeping. Every shred
// of business logic lives behind the injected `CoreServices` seam, so the same
// core serves the in-process Electron renderer and a remote browser without the
// transport knowing what a command or event *means*.
//
// Binding is loopback-only (`127.0.0.1`) and plaintext by default; the API
// uses bearer auth when configured and a same-origin guard when tokenless.

import http from 'node:http'
import https from 'node:https'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import type { Socket } from 'node:net'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import type {
  ClientCommand,
  ClientQuery,
  CommandResult,
  CoreHandshake,
  EventStreamFrame,
  QueryResults
} from './api-contract'
import type { EventCursor } from './events'

/**
 * The injected core seam the transport delegates every action to. The real
 * implementation is assembled in the operations core; tests pass a fake. The
 * transport never imports a store, journal, or coordinator — only this object.
 */
export interface CoreServices {
  handshake(): CoreHandshake
  handleCommand(cmd: ClientCommand): Promise<CommandResult>
  handleQuery<Q extends ClientQuery>(q: Q): Promise<QueryResults[Q['name']]>
  /** Replay events with cursor > afterCursor, then push live frames. Returns an unsubscribe. */
  subscribe(afterCursor: EventCursor, onFrame: (frame: EventStreamFrame) => void): () => void
}

/** Options for `createWebServer`. */
export interface CreateWebServerOptions {
  /** Loopback interface to bind. Defaults to `127.0.0.1`. */
  host?: string
  /**
   * Directory of a built static web client to serve for non-`/api` GET requests,
   * with SPA `index.html` fallback. When unset, only the `/api` surface is served
   * and everything else 404s. Serving the UI here keeps it same-origin with the
   * API, so the browser client needs no CORS and no separate dev origin.
   */
  staticDir?: string
  /**
   * When set, the API surface (`/api/*`) requires this bearer token in an
   * `Authorization: Bearer <token>` header. The SSE `EventSource` cannot set
   * headers, so it uses a single-use ticket minted by `/api/sse-ticket`.
   * Static assets stay open so the app shell can still load. When unset,
   * browser API requests must be same-origin; requests without an Origin
   * header remain allowed for local tooling.
   */
  token?: string
  /**
   * Fixed-window per-IP rate limit for `/api/*`. Defaults to 300 requests / 60s.
   * Set `max` to 0 to disable.
   */
  rateLimit?: { windowMs?: number; max?: number }
  /**
   * When set, the server listens over HTTPS with this PEM key/cert (a Core-
   * generated self-signed pair). Unset = plaintext HTTP (the default). Routing,
   * auth, tickets and CORS are identical either way.
   */
  tls?: { key: string; cert: string }
}

/** A running web server handle. */
export interface WebServer {
  /** Bind to `port` (0 = ephemeral) and resolve with the actually bound port. */
  listen(port: number): Promise<number>
  /** Stop accepting connections, destroy live sockets, and resolve once down. */
  close(): Promise<void>
  /** The bound port once listening, else `null`. */
  readonly port: number | null
}

/** Default loopback bind address. */
const DEFAULT_HOST = '127.0.0.1'

/** Maximum accepted request body size. Over-sized bodies are refused with 413. */
const MAX_BODY_BYTES = 1 * 1024 * 1024

/**
 * Create a loopback HTTP + SSE server that speaks the api-contract over an
 * injected `CoreServices`. Call `listen(0)` for an ephemeral port.
 */
export function createWebServer(
  services: CoreServices,
  options: CreateWebServerOptions = {}
): WebServer {
  const host = options.host ?? DEFAULT_HOST
  const staticDir = options.staticDir
  const token = options.token && options.token.length > 0 ? options.token : null
  const scheme = options.tls ? 'https' : 'http'

  /**
   * Whether a request carries the configured bearer token in the Authorization
   * header. Open when no token is set; loopback requests without a token are
   * protected by the same-origin Origin check below. The token is NEVER read
   * from the query string — the SSE stream authenticates with a single-use
   * ticket (below) so the secret never lands in a URL or a log.
   */
  function authorized(req: http.IncomingMessage): boolean {
    if (!token) return true
    const header = req.headers['authorization']
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
    const candidate = Buffer.from(header.slice('Bearer '.length), 'utf8')
    const expected = Buffer.from(token, 'utf8')
    return candidate.length === expected.length && timingSafeEqual(candidate, expected)
  }

  /**
   * Without a bearer token, browser requests must be same-origin. Requests
   * without an Origin header remain usable for local tooling and the desktop
   * client's same-process fetches; browsers cannot omit Origin on cross-origin
   * state-changing fetches.
   */
  function originAllowed(req: http.IncomingMessage): boolean {
    if (token) return true
    const origin = req.headers.origin
    if (origin === undefined) return true
    if (typeof origin !== 'string' || typeof req.headers.host !== 'string') return false
    try {
      const parsed = new URL(origin)
      return parsed.protocol === `${scheme}:` && parsed.host === req.headers.host
    } catch {
      return false
    }
  }

  /**
   * Short-lived, single-use SSE tickets. `EventSource` cannot set an
   * Authorization header, so a client with a token first POSTs (bearer-authed)
   * to `/api/sse-ticket`, then opens the stream with `?ticket=`. Tickets expire
   * fast and are consumed on first use, so a ticket captured from a URL/log is
   * worthless after the stream opens (or after ~TTL).
   */
  const SSE_TICKET_TTL_MS = 30_000
  const sseTickets = new Map<string, number>()

  function issueSseTicket(): { ticket: string; ttlMs: number } {
    const now = Date.now()
    // Opportunistic prune so abandoned tickets cannot accumulate unbounded.
    if (sseTickets.size > 256) {
      for (const [t, exp] of sseTickets) if (exp <= now) sseTickets.delete(t)
    }
    const ticket = randomUUID()
    sseTickets.set(ticket, now + SSE_TICKET_TTL_MS)
    return { ticket, ttlMs: SSE_TICKET_TTL_MS }
  }

  /** Validate and CONSUME a ticket (single-use); true only if it existed and had not expired. */
  function consumeSseTicket(ticket: string | null): boolean {
    if (!ticket) return false
    const expiresAt = sseTickets.get(ticket)
    if (expiresAt === undefined) return false
    sseTickets.delete(ticket)
    return expiresAt > Date.now()
  }

  const rlWindowMs = options.rateLimit?.windowMs ?? 60_000
  const rlMax = options.rateLimit?.max ?? 300
  /** Fixed-window request counts per client ip (dynamic, runtime — a Map). */
  const rlBuckets = new Map<string, { count: number; resetAt: number }>()

  /** Register a hit for `ip`; returns seconds-until-reset when the limit is exceeded, else null. */
  function rateHit(ip: string): number | null {
    if (rlMax <= 0) return null
    const now = Date.now()
    let bucket = rlBuckets.get(ip)
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + rlWindowMs }
      rlBuckets.set(ip, bucket)
    }
    bucket.count += 1
    if (bucket.count > rlMax) return Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
    return null
  }

  /**
   * DNS-rebinding defense: reject an `/api` request whose Host header is a DNS
   * name. A page that pointed its own domain at this machine would send that
   * domain as Host; legitimate local/LAN clients use an IP literal or localhost.
   */
  function hostAllowed(req: http.IncomingMessage): boolean {
    const raw = (req.headers.host ?? '').trim()
    if (raw === '') return true
    const hostname = raw.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
    if (hostname === 'localhost') return true
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return true
    if (hostname.includes(':')) return true
    return false
  }

  let boundPort: number | null = null
  let listening = false
  let closed = false
  /** Live sockets, tracked so `close()` tears them down instead of waiting on keep-alive expiry. */
  const sockets = new Set<Socket>()

  const requestListener = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    // The single request boundary: no handler may throw out of it. A throw or a
    // rejected promise from the async body becomes a safe 500 with no internals.
    handleRequest(req, res).catch(() => internalError(res))
  }
  const server: http.Server | https.Server = options.tls
    ? https.createServer({ key: options.tls.key, cert: options.tls.cert }, requestListener)
    : http.createServer(requestListener)

  server.on('connection', (socket: Socket) => {
    sockets.add(socket)
    socket.on('close', () => {
      sockets.delete(socket)
    })
  })

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const method = req.method ?? 'GET'
    const pathname = url.pathname

    const isApi = pathname.startsWith('/api/')
    const requestOrigin = typeof req.headers.origin === 'string' ? req.headers.origin : null
    const requestOriginAllowed = originAllowed(req)

    // Token-authenticated clients may be remote, so retain wildcard CORS. The
    // tokenless desktop client is same-origin only: reflect the exact allowed
    // origin and never emit `*` for an unauthenticated API.
    if (token) res.setHeader('Access-Control-Allow-Origin', '*')
    else if (requestOrigin && requestOriginAllowed) res.setHeader('Access-Control-Allow-Origin', requestOrigin)
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    res.setHeader('Access-Control-Max-Age', '600')
    if (method === 'OPTIONS') {
      if (isApi && !requestOriginAllowed) {
        fail(res, 403, 'forbidden-origin', 'origin not allowed')
        return
      }
      res.writeHead(204)
      res.end()
      return
    }

    if (isApi) {
      if (!hostAllowed(req)) {
        fail(res, 403, 'forbidden-host', 'host not allowed')
        return
      }
      if (!requestOriginAllowed) {
        fail(res, 403, 'forbidden-origin', 'origin not allowed')
        return
      }
      const retryAfter = rateHit(req.socket.remoteAddress ?? 'unknown')
      if (retryAfter !== null) {
        res.setHeader('Retry-After', String(retryAfter))
        fail(res, 429, 'rate-limited', 'too many requests')
        return
      }
    }

    // Bearer gate for the API surface. `/api/events` is exempt: EventSource cannot
    // send an Authorization header, so the stream authorizes with a single-use
    // ticket (validated in streamEvents) rather than a token in the URL.
    if (isApi && pathname !== '/api/events' && !authorized(req)) {
      fail(res, 401, 'unauthorized', 'missing or invalid access token')
      return
    }

    if (method === 'GET' && pathname === '/api/handshake') {
      sendJson(res, 200, services.handshake())
      return
    }

    if (method === 'POST' && pathname === '/api/command') {
      const body = await readJsonBody(req)
      if (!body.ok) {
        if (body.reason === 'too-large') fail(res, 413, 'too-large', 'request body exceeds the size limit')
        else fail(res, 400, 'bad-request', body.message)
        return
      }
      sendJson(res, 200, await services.handleCommand(body.value as ClientCommand))
      return
    }

    if (method === 'POST' && pathname === '/api/query') {
      const body = await readJsonBody(req)
      if (!body.ok) {
        if (body.reason === 'too-large') fail(res, 413, 'too-large', 'request body exceeds the size limit')
        else fail(res, 400, 'bad-request', body.message)
        return
      }
      sendJson(res, 200, await services.handleQuery(body.value as ClientQuery))
      return
    }

    if (method === 'POST' && pathname === '/api/sse-ticket') {
      sendJson(res, 200, issueSseTicket())
      return
    }

    if (method === 'GET' && pathname === '/api/events') {
      streamEvents(req, res, url)
      return
    }

    if (method === 'GET' && staticDir && serveStatic(res, staticDir, pathname)) {
      return
    }

    sendJson(res, 404, { error: { code: 'not-found', message: 'not found' } })
  }

  /**
   * Open the SSE stream: validate the cursor, write the opening comment so the
   * stream flushes promptly, then hand the core a frame sink and watch the
   * request lifecycle so a disconnect unsubscribes and ends the response.
   */
  function streamEvents(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    const after = parseAfterCursor(url.searchParams.get('after'))
    if (after === null) {
      fail(res, 400, 'bad-request', "'after' must be a non-negative integer cursor")
      return
    }

    // When a token is configured the stream requires a valid single-use ticket;
    // loopback dev (no token) stays open. The ticket is consumed here, so a
    // captured URL cannot reopen the stream.
    if (token && !consumeSseTicket(url.searchParams.get('ticket'))) {
      fail(res, 401, 'unauthorized', 'missing or invalid SSE ticket')
      return
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    })
    // Opening comment: flushes the headers immediately so a client knows the
    // stream is live before the core emits its first frame.
    res.write(': connected\n\n')

    let torn = false
    const onFrame = (frame: EventStreamFrame): void => {
      if (torn || res.writableEnded || res.destroyed) return
      try {
        res.write(`data: ${JSON.stringify(frame)}\n\n`)
      } catch {
        // Socket gone mid-write; the close handler below tears down.
      }
    }

    let unsubscribe: (() => void) | undefined
    try {
      unsubscribe = services.subscribe(after, onFrame)
    } catch {
      // The core refused the subscription; end the stream cleanly.
      torn = true
      safeEnd(res)
      return
    }

    const teardown = (): void => {
      if (torn) return
      torn = true
      try {
        unsubscribe?.()
      } catch {
        // Never let an unsubscribe throw escape the request boundary.
      }
      safeEnd(res)
    }
    // Both signals reliably fire on client disconnect across Node versions; the
    // `torn` guard makes listening to both safe.
    req.on('close', teardown)
    req.on('error', teardown)
  }

  function listen(port: number): Promise<number> {
    const { promise, resolve, reject } = Promise.withResolvers<number>()
    if (listening) {
      reject(new Error('web server already listening'))
      return promise
    }
    const onError = (err: NodeJS.ErrnoException): void => reject(err)
    server.once('error', onError)
    server.listen(port, host, () => {
      server.removeListener('error', onError)
      listening = true
      const addr = server.address()
      boundPort = typeof addr === 'object' && addr ? addr.port : null
      resolve(boundPort ?? 0)
    })
    return promise
  }

  function close(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>()
    if (closed) {
      resolve()
      return promise
    }
    closed = true
    for (const socket of sockets) {
      try {
        socket.destroy()
      } catch {
        // Best effort; a destroyed socket is the desired end state.
      }
    }
    sockets.clear()
    server.close(() => {
      boundPort = null
      listening = false
      resolve()
    })
    return promise
  }

  return {
    listen,
    close,
    get port(): number | null {
      return boundPort
    }
  }
}

// --------------------------------------------------------------------------- //
// Body framing                                                                //
// --------------------------------------------------------------------------- //

type BodyResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: 'bad-request'; message: string }
  | { ok: false; reason: 'too-large' }

/**
 * Read and JSON-parse a request body, refusing anything over the size limit.
 * An oversize body is still fully drained (chunks discarded past the limit) so
 * the socket is not reset mid-transfer — the client receives a clean 413 rather
 * than an ECONNRESET.
 */
function readJsonBody(req: http.IncomingMessage): Promise<BodyResult> {
  const { promise, resolve } = Promise.withResolvers<BodyResult>()
  const chunks: Buffer[] = []
  let size = 0
  let tooLarge = false
  let settled = false

  const detach = (): void => {
    req.off('data', onData)
    req.off('end', onEnd)
    req.off('error', onError)
  }
  const finish = (result: BodyResult): void => {
    if (settled) return
    settled = true
    detach()
    resolve(result)
  }

  const onData = (chunk: Buffer): void => {
    if (tooLarge) return // keep draining without buffering past the limit
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      tooLarge = true
      chunks.length = 0
      return
    }
    chunks.push(chunk)
  }

  const onEnd = (): void => {
    if (tooLarge) {
      finish({ ok: false, reason: 'too-large' })
      return
    }
    const text = Buffer.concat(chunks).toString('utf8')
    if (text.length === 0) {
      finish({ ok: false, reason: 'bad-request', message: 'request body is empty' })
      return
    }
    try {
      finish({ ok: true, value: JSON.parse(text) })
    } catch {
      finish({ ok: false, reason: 'bad-request', message: 'request body is not valid JSON' })
    }
  }

  const onError = (): void => {
    finish({ ok: false, reason: 'bad-request', message: 'failed to read request body' })
  }

  req.on('data', onData)
  req.on('end', onEnd)
  req.on('error', onError)
  return promise
}

/**
 * Parse the SSE `after` cursor. Absent → 0 (replay from the start); any value
 * that is not a non-negative base-10 integer → `null` (refuse with 400).
 */
function parseAfterCursor(raw: string | null): EventCursor | null {
  if (raw === null) return 0
  const trimmed = raw.trim()
  if (trimmed === '' || !/^\d+$/.test(trimmed)) return null
  const n = Number(trimmed)
  if (!Number.isFinite(n) || n < 0) return null
  return n
}

// --------------------------------------------------------------------------- //
// Response helpers                                                            //
// --------------------------------------------------------------------------- //

/** Write a JSON response with an exact Content-Length so keep-alive framing stays correct. */
function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload)
  })
  res.end(payload)
}

/** Uniform client-error envelope `{ ok:false, error:{code,message} }` for 4xx refusals. */
function fail(res: http.ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { ok: false, error: { code, message } })
}

/** Safe 500. If headers already went out (e.g. mid-SSE), just end the stream. */
function internalError(res: http.ServerResponse): void {
  if (res.headersSent) {
    safeEnd(res)
    return
  }
  sendJson(res, 500, { error: { code: 'internal', message: 'internal error' } })
}

/** End a response without throwing when the socket is already gone. */
function safeEnd(res: http.ServerResponse): void {
  if (res.writableEnded) return
  try {
    res.end()
  } catch {
    // Already torn down; nothing to do.
  }
}

/** Content types for the static file server, by lowercase extension. */
const STATIC_CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
}

/**
 * Serve a file from the built web client under `staticDir`, with an SPA fallback
 * to `index.html` for unknown routes. Returns true when it wrote a response,
 * false when there is nothing to serve (so the caller can 404). Both the
 * lexical path and the resolved real path must remain under `staticDir`.
 */
function serveStatic(res: http.ServerResponse, staticDir: string, pathname: string): boolean {
  let root: string
  try {
    root = realpathSync(staticDir)
  } catch {
    return false
  }

  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(pathname)
  } catch {
    return false
  }
  const requested = resolve(root, decodedPath.replace(/^\/+/, ''))
  const withinRoot = requested === root || requested.startsWith(root + sep)
  if (!withinRoot) return false

  let filePath: string
  if (requested === root || !existsSync(requested) || statSync(requested).isDirectory()) {
    filePath = join(root, 'index.html')
  } else {
    filePath = requested
  }
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    // No built client (or no index.html) — let the caller 404.
    return false
  }

  let realFilePath: string
  try {
    realFilePath = realpathSync(filePath)
  } catch {
    return false
  }
  const realWithinRoot = realFilePath === root || realFilePath.startsWith(root + sep)
  if (!realWithinRoot || statSync(realFilePath).isDirectory()) return false

  const body = readFileSync(realFilePath)
  const type = STATIC_CONTENT_TYPES[extname(realFilePath).toLowerCase()] ?? 'application/octet-stream'
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.byteLength })
  res.end(body)
  return true
}
