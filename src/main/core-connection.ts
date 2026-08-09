// Resilient wrapper around the Core control connection.
//
// The lesson from a real outage: if the Core failed to connect at boot, the app
// registered no IPC and went silently inert — indistinguishable from data loss.
// This manager fixes that: it connects with backoff retry, auto-reconnects when
// the control socket drops (Core restarted), and pushes a `CoreStatus` so the
// renderer can SAY what's happening. `call()` never depends on a one-shot
// connect — it (re)connects on demand and rejects with a clear message while
// the Core is unavailable, rather than hanging or throwing "no IPC handler".

import type { CoreClient } from './core-client'

/** Connection lifecycle surfaced to the renderer. */
export type CoreStatus = { state: 'connecting' | 'connected' | 'error'; detail?: string }

export interface CoreConnection {
  /** (Re)connect if needed, then invoke a backend method; rejects clearly while unavailable. */
  call<T = unknown>(method: string, ...args: unknown[]): Promise<T>
  /** The current connection status. */
  status(): CoreStatus
  /** Begin connecting (idempotent). */
  start(): void
  /** Force an immediate fresh connect attempt (operator Retry). */
  reconnect(): void
  /** Close the current client (does not stop the Core). */
  close(): void
}

export interface CoreConnectionOptions {
  /** Establishes a fresh client — production passes `() => connectOrSpawnCore(opts)`. */
  connect: () => Promise<CoreClient>
  /** Called on every status change (production forwards it to the renderer as `core:status`). */
  onStatus: (status: CoreStatus) => void
  /** Called for every Core→client event push (production re-broadcasts to the renderer). */
  onEvent: (channel: string, args: unknown[]) => void
  /** Backoff schedule between retries; the last value repeats. Defaults to 0.5s→5s. */
  retryDelaysMs?: number[]
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

const DEFAULT_RETRY_MS = [500, 1000, 2000, 5000]

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createCoreConnection(options: CoreConnectionOptions): CoreConnection {
  const retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_MS
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout))

  let client: CoreClient | null = null
  let connecting: Promise<CoreClient> | null = null
  let retryHandle: unknown = null
  let attempt = 0
  let closed = false
  let status: CoreStatus = { state: 'connecting' }

  function setStatus(next: CoreStatus): void {
    if (status.state === next.state && status.detail === next.detail) return
    status = next
    options.onStatus(next)
  }

  function scheduleRetry(): void {
    if (closed || retryHandle) return
    const delay = retryDelays[Math.min(attempt, retryDelays.length - 1)]
    attempt += 1
    retryHandle = setTimer(() => {
      retryHandle = null
      void ensure().catch(() => undefined)
    }, delay)
  }

  function handleDrop(): void {
    // Only react to the drop of the CURRENT client (a stale client's late close
    // must not clobber a newer connection).
    client = null
    if (closed) return
    setStatus({ state: 'connecting' })
    scheduleRetry()
  }

  function ensure(): Promise<CoreClient> {
    if (client) return Promise.resolve(client)
    if (connecting) return connecting
    setStatus({ state: 'connecting' })
    connecting = (async () => {
      try {
        const fresh = await options.connect()
        client = fresh
        attempt = 0
        fresh.onEvent(options.onEvent)
        fresh.onClose(() => {
          if (client === fresh) handleDrop()
        })
        setStatus({ state: 'connected' })
        return fresh
      } catch (error) {
        setStatus({ state: 'error', detail: messageOf(error) })
        scheduleRetry()
        throw error
      } finally {
        connecting = null
      }
    })()
    return connecting
  }

  return {
    async call<T>(method: string, ...args: unknown[]): Promise<T> {
      const active = client ?? (await ensure().catch(() => null))
      if (!active) {
        throw new Error('Conductor Core is not available yet — reconnecting…')
      }
      return active.call<T>(method, ...args)
    },
    status: () => status,
    start(): void {
      void ensure().catch(() => undefined)
    },
    reconnect(): void {
      if (closed) return
      if (retryHandle) {
        clearTimer(retryHandle)
        retryHandle = null
      }
      attempt = 0
      const stale = client
      client = null
      stale?.close()
      void ensure().catch(() => undefined)
    },
    close(): void {
      closed = true
      if (retryHandle) {
        clearTimer(retryHandle)
        retryHandle = null
      }
      client?.close()
      client = null
    }
  }
}
