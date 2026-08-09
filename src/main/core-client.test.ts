import { createServer, type AddressInfo } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it, expect, vi } from 'vitest'
import { bootCore, type BootedCore } from '../core/main'
import { encodeFrame } from '../core/control-protocol'
import { connectOrSpawnCore, openClient, resolveCoreLogPath, type CoreClient } from './core-client'

describe('core client ↔ running Core', () => {
  let core: BootedCore | null = null
  let client: CoreClient | null = null

  afterEach(async () => {
    if (client) client.close()
    client = null
    if (core) await core.stop()
    core = null
  })

  it('connects to a healthy Core and round-trips a backend call', async () => {
    const base = mkdtempSync(join(tmpdir(), 'core-client-'))
    core = await bootCore({ base, port: 0, controlPort: 0, webPort: 0 })

    // A Core is already healthy, so this connects rather than spawning; the
    // coreEntry path is therefore never used here.
    client = await connectOrSpawnCore({ base, coreEntry: join(base, 'unused-core-entry.js') })

    const sessionsList = await client.call('session:list')
    expect(sessionsList).toEqual([])

    const repos = await client.call('repo:list')
    expect(repos).toEqual([])
  })

  it('rejects an unknown method with the Core\u2019s safe error', async () => {
    const base = mkdtempSync(join(tmpdir(), 'core-client-'))
    core = await bootCore({ base, port: 0, controlPort: 0, webPort: 0 })
    client = await connectOrSpawnCore({ base, coreEntry: join(base, 'unused.js') })

    await expect(client.call('does:not:exist')).rejects.toThrow(/unknown control method/)
  })
  it('resolves the default Core log path under the versioned data dir', () => {
    const previous = process.env.CONDUCTOR_CORE_LOG
    delete process.env.CONDUCTOR_CORE_LOG
    try {
      const base = mkdtempSync(join(tmpdir(), 'core-client-log-'))
      expect(resolveCoreLogPath(base)).toBe(join(base, 'conductor-data', 'v2', 'logs', 'core.log'))
    } finally {
      if (previous === undefined) delete process.env.CONDUCTOR_CORE_LOG
      else process.env.CONDUCTOR_CORE_LOG = previous
    }
  })

  it('rejects a control RPC when its response never arrives', async () => {
    const server = createServer((socket) => {
      socket.setEncoding('utf8')
      let authenticated = false
      socket.on('data', () => {
        if (authenticated) return
        authenticated = true
        socket.write(encodeFrame({ auth: true, ok: true }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('expected a TCP address')
    const addressInfo: AddressInfo = address
    const port = addressInfo.port
    try {
      client = await openClient('127.0.0.1', port, 'secret', 20)
      await expect(client.call('neverResponds')).rejects.toThrow(
        'control RPC "neverResponds" timed out after 20ms'
      )
    } finally {
      client?.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
  it('does not time out a long-running control RPC', async () => {
    vi.useFakeTimers()
    let responseScheduledResolve: (() => void) | undefined
    const responseScheduled = new Promise<void>((resolve) => {
      responseScheduledResolve = resolve
    })
    const server = createServer((socket) => {
      socket.setEncoding('utf8')
      let authenticated = false
      socket.on('data', (chunk) => {
        if (!authenticated) {
          authenticated = true
          socket.write(encodeFrame({ auth: true, ok: true }))
          return
        }
        const request = JSON.parse(chunk.toString().trim()) as { id: number }
        setTimeout(() => socket.write(encodeFrame({ id: request.id, ok: true, value: 'completed' })), 30)
        responseScheduledResolve?.()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('expected a TCP address')
    const addressInfo: AddressInfo = address
    try {
      client = await openClient('127.0.0.1', addressInfo.port, 'secret', 20)
      const result = client.call('roundtable:start')
      await responseScheduled
      await vi.advanceTimersByTimeAsync(30)
      await expect(result).resolves.toBe('completed')
    } finally {
      vi.useRealTimers()
      client?.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
