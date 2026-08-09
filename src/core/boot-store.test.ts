// Regression: the standalone Core must LOAD the persisted store from disk on
// boot. With the standalone-Core cutover, `bootCore` created the backend (which
// imports the module-level `store` singleton) without ever calling
// `store.init()`, so the singleton's in-memory cache stayed EMPTY even though a
// populated store sat on disk — `repo:list` returned `[]` and a later settings
// write would persist that empty cache over the real store. This test seeds a
// real store and asserts the booted Core serves it.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it, expect } from 'vitest'
import { bootCore, type BootedCore } from './main'
import { resolveCoreDataDir } from './data-dir'
import { connectOrSpawnCore, type CoreClient } from '../main/core-client'

describe('Core loads the persisted store from disk on boot', () => {
  let core: BootedCore | null = null
  let client: CoreClient | null = null

  afterEach(async () => {
    if (client) client.close()
    client = null
    if (core) await core.stop()
    core = null
  })

  it('serves the seeded repo from the migrated store and leaves it intact', async () => {
    const base = mkdtempSync(join(tmpdir(), 'core-boot-store-'))

    // A populated legacy (pre-versioned) store in a valid v2 shape. The Core
    // imports this ONCE into <base>/conductor-data/v2/store.json, then must LOAD
    // that file on boot so the in-memory cache reflects it — not an empty store.
    const seededRepo = { id: 'r1', path: 'D:/Example', name: 'Example', addedAt: 1 }
    const seeded = {
      schemaVersion: 2,
      repos: [seededRepo],
      settings: {},
      worktrees: {},
      ravel: [],
      roundtables: [],
      insights: { current: null, lastGlobalShownAt: 0, lastShownByRule: {}, seen: [] }
    }
    const legacyStoreDir = join(base, 'conductor-data')
    mkdirSync(legacyStoreDir, { recursive: true })
    writeFileSync(join(legacyStoreDir, 'store.json'), JSON.stringify(seeded, null, 2), 'utf8')

    core = await bootCore({ base, port: 0, controlPort: 0, webPort: 0 })

    // A Core is already healthy, so this connects rather than spawning; the
    // coreEntry path is therefore never used here.
    client = await connectOrSpawnCore({ base, coreEntry: join(base, 'unused.js') })

    const repos = (await client.call('repo:list')) as Array<{ id: string; path: string; name: string }>
    expect(repos).toHaveLength(1)
    expect(repos[0]).toMatchObject({ id: 'r1', path: 'D:/Example', name: 'Example' })

    // Boot must not have overwritten the migrated store with an empty one.
    const v2Store = JSON.parse(readFileSync(join(resolveCoreDataDir(base), 'store.json'), 'utf8'))
    expect(v2Store.repos).toEqual([seededRepo])
  })
})
