import { afterEach, describe, expect, it } from 'vitest'
import { createWebServer } from './web-server'
import type { CoreServices, WebServer } from './web-server'
import type { ClientCommand, ClientQuery, EventStreamFrame, QueryResults } from './api-contract'
import type { NormalizedEvent } from './events'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import https from 'node:https'
import type { TLSSocket } from 'node:tls'
import { loadOrCreateTls } from './tls'

// Fixed epoch — never Date.now(). Timestamps here are arbitrary ms.
const T0 = 1_700_000_000_000

// Server-side body limit is 1 MB; a body one byte over must trigger 413.
const ONE_MB = 1024 * 1024

/**
 * Build a fully-populated NormalizedEvent from a cursor so the SSE round-trip
 * serializes and re-parses every field faithfully.
 */
function mkEvent(cursor: number, over: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    id: `evt-${cursor}`,
    cursor,
    timestamp: T0 + cursor * 60_000,
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
    summary: `event ${cursor}`,
    evidenceRefs: [],
    source: {},
    ...over
  }
}

interface FakeState {
  lastCommand: ClientCommand | null
  lastQuery: ClientQuery | null
  subscribeAfter: number | null
  unsubscribed: boolean
  /** Resolves with the cursor the transport subscribed with, once wired. */
  subscribed: Promise<number>
  /** Resolves once the transport called the unsubscribe handle. */
  unsubscribedSignal: Promise<void>
  emit: (frame: EventStreamFrame) => void
}

/**
 * A fake CoreServices that records what the transport forwarded and exposes
 * promise signals for subscription/unsubscription plus a frame sink the test
 * can push through. Awaiting those signals (rather than polling a clock) is how
 * the tests stay deterministic against real loopback I/O.
 */
function makeFake(): { services: CoreServices; state: FakeState } {
  let frameSink: ((frame: EventStreamFrame) => void) | null = null
  const subscribeCtl = Promise.withResolvers<number>()
  const unsubscribeCtl = Promise.withResolvers<void>()
  const state: FakeState = {
    lastCommand: null,
    lastQuery: null,
    subscribeAfter: null,
    unsubscribed: false,
    subscribed: subscribeCtl.promise,
    unsubscribedSignal: unsubscribeCtl.promise,
    emit: (frame) => {
      frameSink?.(frame)
    }
  }
  const services: CoreServices = {
    handshake: () => ({
      coreVersion: 'test-core',
      apiVersion: 1,
      storeSchemaVersion: 3,
      capabilities: ['command', 'query', 'events'],
      cursor: 42
    }),
    handleCommand: async (cmd) => {
      state.lastCommand = cmd
      return { ok: true, operationId: cmd.operationId, deduplicated: false, value: { echoed: cmd.name } }
    },
    handleQuery: <Q extends ClientQuery>(q: Q): Promise<QueryResults[Q['name']]> => {
      state.lastQuery = q
      return Promise.resolve({ name: q.name, received: true } as unknown as QueryResults[Q['name']])
    },
    subscribe: (after, onFrame) => {
      state.subscribeAfter = after
      frameSink = onFrame
      subscribeCtl.resolve(after)
      return () => {
        state.unsubscribed = true
        frameSink = null
        unsubscribeCtl.resolve()
      }
    }
  }
  return { services, state }
}

/** Spin up a server on an ephemeral port and remember it for afterEach teardown. */
let server: WebServer | null = null
async function start(services: CoreServices): Promise<number> {
  server = createWebServer(services)
  return server.listen(0)
}

afterEach(async () => {
  if (server) {
    await server.close()
    server = null
  }
})

/** Read `count` SSE `data:` payloads off a response-body reader, ignoring comments. */
async function readSseMessages(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  count: number
): Promise<unknown[]> {
  const decoder = new TextDecoder()
  let buf = ''
  const messages: unknown[] = []
  while (messages.length < count) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      const dataLine = block.split('\n').find((line) => line.startsWith('data: '))
      if (dataLine) messages.push(JSON.parse(dataLine.slice('data: '.length)))
    }
  }
  return messages
}

describe('createWebServer — routing and framing', () => {
  it('GET /api/handshake returns the injected handshake object', async () => {
    const { services } = makeFake()
    const port = await start(services)

    const res = await fetch(`http://127.0.0.1:${port}/api/handshake`)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      coreVersion: 'test-core',
      apiVersion: 1,
      storeSchemaVersion: 3,
      capabilities: ['command', 'query', 'events'],
      cursor: 42
    })
  })

  it('POST /api/command passes the parsed command through and returns the result', async () => {
    const { services, state } = makeFake()
    const port = await start(services)
    const command: ClientCommand = {
      operationId: 'op-1',
      name: 'automation.setEnabled',
      payload: { automationId: 'a-1', enabled: true }
    }

    const res = await fetch(`http://127.0.0.1:${port}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(command)
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      operationId: 'op-1',
      deduplicated: false,
      value: { echoed: 'automation.setEnabled' }
    })
    expect(state.lastCommand).toEqual(command)
  })

  it('returns 400 (not a crash) for a malformed JSON command body', async () => {
    const { services } = makeFake()
    const port = await start(services)

    const res = await fetch(`http://127.0.0.1:${port}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not valid json'
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      ok: false,
      error: { code: 'bad-request', message: expect.any(String) }
    })
  })

  it('returns 413 when the request body exceeds the size limit', async () => {
    const { services, state } = makeFake()
    const port = await start(services)

    const res = await fetch(`http://127.0.0.1:${port}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'x'.repeat(ONE_MB + 1)
    })

    expect(res.status).toBe(413)
    // An oversize body must never reach the core.
    expect(state.lastCommand).toBeNull()
  })

  it('POST /api/query passes the parsed query through and returns the result', async () => {
    const { services, state } = makeFake()
    const port = await start(services)
    const query: ClientQuery = { name: 'automation.list' }

    const res = await fetch(`http://127.0.0.1:${port}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(query)
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ name: 'automation.list', received: true })
    expect(state.lastQuery).toEqual(query)
  })

  it('returns 400 for a malformed JSON query body', async () => {
    const { services } = makeFake()
    const port = await start(services)

    const res = await fetch(`http://127.0.0.1:${port}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '<<<not json>>>'
    })

    expect(res.status).toBe(400)
  })

  it('returns 404 JSON for an unknown path', async () => {
    const { services } = makeFake()
    const port = await start(services)

    const res = await fetch(`http://127.0.0.1:${port}/api/no-such-route`)

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: { code: 'not-found', message: 'not found' } })
  })
})

describe('createWebServer — SSE event stream', () => {
  it('streams emitted event/gap frames, replays from afterCursor, and unsubscribes on disconnect', async () => {
    const { services, state } = makeFake()
    const port = await start(services)

    const controller = new AbortController()
    const res = await fetch(`http://127.0.0.1:${port}/api/events?after=5`, {
      signal: controller.signal
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    expect(res.headers.get('cache-control')).toBe('no-cache')

    const reader = res.body!.getReader()

    // Await the real subscription signal — the transport must replay from 5.
    expect(await state.subscribed).toBe(5)

    const event = mkEvent(6)
    state.emit({ type: 'event', event })
    state.emit({ type: 'gap', earliestAvailable: 9 })

    const messages = await readSseMessages(reader, 2)
    expect(messages).toEqual([
      { type: 'event', event },
      { type: 'gap', earliestAvailable: 9 }
    ])

    controller.abort()
    // Await the real disconnect signal — the transport must call unsubscribe.
    await state.unsubscribedSignal
    expect(state.unsubscribed).toBe(true)
  })

  it('defaults afterCursor to 0 when after is absent and rejects non-numeric with 400', async () => {
    const { services, state } = makeFake()
    const port = await start(services)

    const controller = new AbortController()
    const res = await fetch(`http://127.0.0.1:${port}/api/events`, { signal: controller.signal })
    expect(res.status).toBe(200)
    expect(await state.subscribed).toBe(0)

    controller.abort()
    await state.unsubscribedSignal

    // Non-numeric `after` is refused without subscribing.
    const bad = await fetch(`http://127.0.0.1:${port}/api/events?after=abc`)
    expect(bad.status).toBe(400)
  })
})

describe('createWebServer — lifecycle', () => {
  it('exposes the bound port while listening and null once closed', async () => {
    const { services } = makeFake()
    server = createWebServer(services)
    expect(server.port).toBeNull()

    const port = await server.listen(0)
    expect(port).toBeGreaterThan(0)
    expect(server.port).toBe(port)

    await server.close()
    expect(server.port).toBeNull()
    server = null // already closed; stop afterEach from double-closing
  })

  it('close() shuts the server down so further requests fail to connect', async () => {
    const { services } = makeFake()
    const port = await start(services)
    await server!.close()
    server = null // already closed; stop afterEach from double-closing

    await expect(fetch(`http://127.0.0.1:${port}/api/handshake`)).rejects.toThrow()
  })
})

describe('createWebServer — static web client', () => {
  it('serves an asset, falls back to index.html for SPA routes, refuses traversal, and 404s without a build', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'web-static-'))
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>ui</title>')
    writeFileSync(join(dir, 'app.js'), 'export const x = 1')
    const { services } = makeFake()
    server = createWebServer(services, { staticDir: dir })
    const port = await server.listen(0)
    const at = (p: string): Promise<Response> => fetch(`http://127.0.0.1:${port}${p}`)

    const asset = await at('/app.js')
    expect(asset.status).toBe(200)
    expect(asset.headers.get('content-type')).toContain('text/javascript')
    expect(await asset.text()).toBe('export const x = 1')

    // An unknown client route falls back to index.html (SPA), not 404.
    const route = await at('/workers/sess-1')
    expect(route.status).toBe(200)
    expect(await route.text()).toContain('<title>ui</title>')

    // The root serves index.html.
    expect(await (await at('/')).text()).toContain('<title>ui</title>')

    // A path-traversal attempt cannot escape the static root; it falls back to index.html.
    const escape = await at('/../../secret')
    expect(escape.status).toBe(200)
    expect(await escape.text()).toContain('<title>ui</title>')

    // The API surface still wins over the static fallback.
    expect((await at('/api/handshake')).status).toBe(200)

    rmSync(dir, { recursive: true, force: true })
  })

  it('404s non-API GETs when no static client is configured', async () => {
    const { services } = makeFake()
    const port = await start(services)
    const res = await fetch(`http://127.0.0.1:${port}/index.html`)
    expect(res.status).toBe(404)
  })
  it('refuses a symlinked static file whose real path escapes the static root', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'web-static-root-'))
    const outside = mkdtempSync(join(tmpdir(), 'web-static-outside-'))

    writeFileSync(join(dir, 'index.html'), '<title>safe</title>')
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    symlinkSync(outside, join(dir, 'linked'), 'junction')
    const { services } = makeFake()
    server = createWebServer(services, { staticDir: dir })
    const port = await server.listen(0)

    try {
      const res = await fetch(`http://127.0.0.1:${port}/linked/secret.txt`)
      expect(res.status).toBe(404)
      expect(await res.text()).not.toContain('secret')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('createWebServer — CORS and token auth', () => {
  it('allows same-origin state changes but rejects cross-origin state changes without a token', async () => {
    const { services, state } = makeFake()
    server = createWebServer(services)
    const port = await server.listen(0)
    const command: ClientCommand = {
      operationId: 'origin-check',
      name: 'automation.setEnabled',
      payload: { automationId: 'a-1', enabled: true }
    }
    const at = (origin: string): Promise<Response> =>
      fetch(`http://127.0.0.1:${port}/api/command`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify(command)
      })

    const rejectedPreflight = await fetch(`http://127.0.0.1:${port}/api/command`, {
      method: 'OPTIONS',
      headers: { origin: 'http://evil.example', 'access-control-request-method': 'POST' }
    })
    expect(rejectedPreflight.status).toBe(403)
    expect(rejectedPreflight.headers.get('access-control-allow-origin')).not.toBe('*')

    const allowedPreflight = await fetch(`http://127.0.0.1:${port}/api/command`, {
      method: 'OPTIONS',
      headers: { origin: `http://127.0.0.1:${port}`, 'access-control-request-method': 'POST' }
    })
    expect(allowedPreflight.status).toBe(204)
    expect(allowedPreflight.headers.get('access-control-allow-origin')).toBe(`http://127.0.0.1:${port}`)

    const rejected = await at('http://evil.example')
    expect(rejected.status).toBe(403)
    expect(rejected.headers.get('access-control-allow-origin')).not.toBe('*')
    expect(state.lastCommand).toBeNull()

    const allowed = await at(`http://127.0.0.1:${port}`)
    expect(allowed.status).toBe(200)
    expect(allowed.headers.get('access-control-allow-origin')).toBe(`http://127.0.0.1:${port}`)
    expect(state.lastCommand).toEqual(command)

    const noOrigin = await fetch(`http://127.0.0.1:${port}/api/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(command)
    })
    expect(noOrigin.status).toBe(200)
  })
  it('gates /api behind the bearer header only (never a query token) and sets CORS headers', async () => {
    const { services } = makeFake()
    server = createWebServer(services, { token: 'sekret' })
    const port = await server.listen(0)
    const at = (p: string, init?: RequestInit): Promise<Response> =>
      fetch(`http://127.0.0.1:${port}${p}`, init)

    const no = await at('/api/handshake')
    expect(no.status).toBe(401)
    expect(no.headers.get('access-control-allow-origin')).toBe('*')

    expect((await at('/api/handshake', { headers: { authorization: 'Bearer sekret' } })).status).toBe(200)
    // The token is NEVER accepted from the query string — the secret must not ride in a URL.
    expect((await at('/api/handshake?token=sekret')).status).toBe(401)
    expect((await at('/api/handshake', { headers: { authorization: 'Bearer nope' } })).status).toBe(401)
    expect((await at('/api/handshake', { headers: { authorization: 'Bearer secre7' } })).status).toBe(401)

    const pre = await at('/api/command', { method: 'OPTIONS' })
    expect(pre.status).toBe(204)
    expect(pre.headers.get('access-control-allow-headers')).toContain('Authorization')
  })

  it('serves static assets without a token even when the API is gated', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'web-auth-'))
    writeFileSync(join(dir, 'index.html'), '<div id="root"></div>')
    const { services } = makeFake()
    server = createWebServer(services, { token: 'sekret', staticDir: dir })
    const port = await server.listen(0)
    const res = await fetch(`http://127.0.0.1:${port}/`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('id="root"')
    rmSync(dir, { recursive: true, force: true })
  })

  it('authorizes the SSE stream with a single-use ticket, never a query token', async () => {
    const { services } = makeFake()
    server = createWebServer(services, { token: 'sekret' })
    const port = await server.listen(0)
    const at = (p: string, init?: RequestInit): Promise<Response> =>
      fetch(`http://127.0.0.1:${port}${p}`, init)

    // A ticket requires the bearer header; the stream is refused without one.
    expect((await at('/api/events?after=0')).status).toBe(401)
    expect((await at('/api/events?after=0&token=sekret')).status).toBe(401)
    expect((await at('/api/sse-ticket', { method: 'POST' })).status).toBe(401)

    const minted = await at('/api/sse-ticket', { method: 'POST', headers: { authorization: 'Bearer sekret' } })
    expect(minted.status).toBe(200)
    const { ticket, ttlMs } = (await minted.json()) as { ticket: string; ttlMs: number }
    expect(typeof ticket).toBe('string')
    expect(ttlMs).toBeGreaterThan(0)

    // The ticket opens the stream exactly once (single-use), then is spent.
    const controller = new AbortController()
    const opened = await fetch(`http://127.0.0.1:${port}/api/events?after=0&ticket=${ticket}`, { signal: controller.signal })
    expect(opened.status).toBe(200)
    controller.abort()
    expect((await at(`/api/events?after=0&ticket=${ticket}`)).status).toBe(401)
    expect((await at('/api/events?after=0&ticket=bogus')).status).toBe(401)
  })

  it('serves the API over HTTPS with the Core cert, pinning a stable fingerprint', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ws-tls-'))
    const tls = loadOrCreateTls(dir)
    const { services } = makeFake()
    server = createWebServer(services, { tls: { key: tls.key, cert: tls.cert } })
    const port = await server.listen(0)
    const { status, peerFingerprint } = await httpsGet(port, '/api/handshake')
    expect(status).toBe(200)
    // The cert the client sees is exactly the one whose fingerprint rides in the pairing code.
    expect(peerFingerprint).toBe(tls.fingerprint)
    rmSync(dir, { recursive: true, force: true })
  })
})

/** Raw GET so a test can spoof the Host header (undici forbids overriding it). */
function rawGet(port: number, path: string, headers: Record<string, string>): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>()
  const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
    res.resume()
    res.on('end', () => resolve(res.statusCode ?? 0))
  })
  req.on('error', reject)
  req.end()
  return promise
}

/** HTTPS GET that accepts the self-signed cert and reports the peer's SHA-256 fingerprint. */
function httpsGet(port: number, path: string): Promise<{ status: number; peerFingerprint: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; peerFingerprint: string }>()
  const req = https.request(
    { host: '127.0.0.1', port, path, method: 'GET', rejectUnauthorized: false },
    (res) => {
      const peerFingerprint = (res.socket as TLSSocket).getPeerCertificate().fingerprint256
      res.resume()
      res.on('end', () => resolve({ status: res.statusCode ?? 0, peerFingerprint }))
    }
  )
  req.on('error', reject)
  req.end()
  return promise
}

describe('createWebServer — rate limit and host guard', () => {
  it('429s /api past the per-IP window with a Retry-After header', async () => {
    const { services } = makeFake()
    server = createWebServer(services, { rateLimit: { max: 2, windowMs: 60_000 } })
    const port = await server.listen(0)
    const at = (): Promise<Response> => fetch(`http://127.0.0.1:${port}/api/handshake`)

    expect((await at()).status).toBe(200)
    expect((await at()).status).toBe(200)
    const limited = await at()
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  it('rejects an /api request whose Host is a DNS name (DNS-rebinding guard)', async () => {
    const { services } = makeFake()
    server = createWebServer(services)
    const port = await server.listen(0)

    expect(await rawGet(port, '/api/handshake', { host: 'evil.example.com' })).toBe(403)
    expect(await rawGet(port, '/api/handshake', { host: `127.0.0.1:${port}` })).toBe(200)
  })
})
