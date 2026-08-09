import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it, expect } from 'vitest'
import { bootCore, CoreAlreadyRunning, type BootedCore } from './main'
import { connectOrSpawnCore, type CoreClient } from '../main/core-client'

describe('bootCore lifecycle', () => {
  let core: BootedCore | null = null
  let client: CoreClient | null = null
  afterEach(async () => {
    if (client) client.close()
    client = null
    if (core) await core.stop()
    core = null
  })

  it('serves /health and refuses a second Core on the same data dir', async () => {
    const base = mkdtempSync(join(tmpdir(), 'core-boot-'))
    core = await bootCore({ base, port: 0 })

    const res = await fetch(`http://127.0.0.1:${core.port}/health`)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.pid).toBe(process.pid)
    expect(body.dataDir).toBe(core.dataDir)
    expect(typeof body.controlPort).toBe('number')
    expect(core.controlPort).toBeGreaterThan(0)
    await expect(bootCore({ base, port: 0 })).rejects.toBeInstanceOf(CoreAlreadyRunning)
  })

  it('releases the lock on stop so a later Core can boot the same dir', async () => {
    const base = mkdtempSync(join(tmpdir(), 'core-boot-'))
    const first = await bootCore({ base, port: 0 })
    await first.stop()
    // A fresh boot after stop must succeed (lock released, endpoint reusable).
    core = await bootCore({ base, port: 0 })
    const res = await fetch(`http://127.0.0.1:${core.port}/health`)
    expect((await res.json()).ok).toBe(true)
  })

  it('publishes a per-boot control secret and confines file RPCs to Core data and stored repos', async () => {
    const base = mkdtempSync(join(tmpdir(), 'core-boot-files-'))
    const repoRoot = mkdtempSync(join(tmpdir(), 'core-allowlisted-repo-'))
    mkdirSync(join(repoRoot, 'src'), { recursive: true })
    writeFileSync(join(repoRoot, 'src', 'allowed.ts'), 'export const allowed = true\n', 'utf8')
    mkdirSync(join(base, 'conductor-data'), { recursive: true })
    writeFileSync(
      join(base, 'conductor-data', 'store.json'),
      JSON.stringify({
        schemaVersion: 2,
        repos: [{ id: 'repo-1', path: repoRoot, name: 'allowed', addedAt: 1 }],
        settings: {},
        worktrees: {},
        ravel: [],
        roundtables: [],
        insights: { current: null, lastGlobalShownAt: 0, lastShownByRule: {}, seen: [] }
      }),
      'utf8'
    )
    core = await bootCore({ base, port: 0, controlPort: 0, webPort: 0 })
    const endpointPath = join(core.dataDir, 'core-endpoint.json')
    const endpoint = JSON.parse(readFileSync(endpointPath, 'utf8')) as { secret?: string }
    if (process.platform !== 'win32') expect(statSync(endpointPath).mode & 0o777).toBe(0o600)
    expect(endpoint.secret).toMatch(/^[0-9a-f]{64}$/)
    client = await connectOrSpawnCore({ base, coreEntry: join(base, 'unused.js') })

    const coreFile = join(core.dataDir, 'allowed.txt')
    expect(await client.call('system:writeFile', coreFile, 'core data')).toBe(true)
    expect(await client.call('system:readFile', coreFile)).toBe('core data')
    expect(await client.call('system:readFile', join(repoRoot, 'src', 'allowed.ts'))).toContain('allowed = true')

    await expect(client.call('system:readFile', join(repoRoot, '..', 'escape.txt'))).rejects.toThrow(/outside allowed roots/)
    await expect(client.call('system:writeFile', join(repoRoot, '..', 'escape.txt'), 'nope')).rejects.toThrow(/outside allowed roots/)
  })
})
