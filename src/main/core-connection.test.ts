import { describe, it, expect } from 'vitest'
import { createCoreConnection, type CoreStatus } from './core-connection'
import type { CoreClient } from './core-client'

/** A fake CoreClient whose socket drop can be triggered, for reconnect tests. */
function fakeClient(): { client: CoreClient; drop: () => void } {
  let onClose = (): void => {}
  const client: CoreClient = {
    call: async <T>(method: string) => `${method}:ok` as unknown as T,
    onEvent: () => {},
    onClose: (cb) => {
      onClose = cb
    },
    close: () => {}
  }
  return { client, drop: () => onClose() }
}

interface FakeTimers {
  setTimer: (fn: () => void) => unknown
  clearTimer: (handle: unknown) => void
  /** Fire every pending timer callback synchronously. */
  flush: () => void
}

function fakeTimers(): FakeTimers {
  const pending: (() => void)[] = []
  return {
    setTimer: (fn) => {
      pending.push(fn)
      return pending.length - 1
    },
    clearTimer: () => {},
    flush: () => {
      for (const fn of pending.splice(0)) fn()
    }
  }
}

/** Drain the microtask queue (no real timers) so injected async connects settle. */
async function flushMicro(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
}

describe('createCoreConnection', () => {
  it('connects, reports connected, and proxies calls', async () => {
    const { client } = fakeClient()
    const statuses: CoreStatus[] = []
    const timers = fakeTimers()
    const conn = createCoreConnection({
      connect: async () => client,
      onStatus: (s) => statuses.push(s),
      onEvent: () => {},
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer
    })
    conn.start()
    await flushMicro()
    expect(conn.status().state).toBe('connected')
    // 'connecting' is the initial state (read via getCoreStatus); only the
    // transition to 'connected' is emitted.
    expect(statuses.map((s) => s.state)).toEqual(['connected'])
    expect(await conn.call('repo:list')).toBe('repo:list:ok')
  })

  it('retries with backoff after a failed connect, then succeeds', async () => {
    const { client } = fakeClient()
    let attempts = 0
    const timers = fakeTimers()
    const conn = createCoreConnection({
      connect: async () => {
        attempts += 1
        if (attempts < 3) throw new Error('refused')
        return client
      },
      onStatus: () => {},
      onEvent: () => {},
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer
    })
    conn.start()
    await flushMicro()
    expect(conn.status().state).toBe('error')
    timers.flush()
    await flushMicro()
    timers.flush()
    await flushMicro()
    expect(attempts).toBe(3)
    expect(conn.status().state).toBe('connected')
  })

  it('auto-reconnects when the control socket drops', async () => {
    const { client, drop } = fakeClient()
    const timers = fakeTimers()
    const conn = createCoreConnection({
      connect: async () => client,
      onStatus: () => {},
      onEvent: () => {},
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer
    })
    conn.start()
    await flushMicro()
    expect(conn.status().state).toBe('connected')

    drop()
    expect(conn.status().state).toBe('connecting')
    timers.flush()
    await flushMicro()
    expect(conn.status().state).toBe('connected')
  })

  it('rejects a call with a clear message while the Core is unavailable', async () => {
    const timers = fakeTimers()
    const conn = createCoreConnection({
      connect: async () => {
        throw new Error('refused')
      },
      onStatus: () => {},
      onEvent: () => {},
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer
    })
    conn.start()
    await flushMicro()
    await expect(conn.call('repo:list')).rejects.toThrow(/not available/i)
  })
})
