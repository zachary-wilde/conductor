import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { resolveCoreDataDir, importLegacyStoreOnce, acquireLock, releaseLock } from './data-dir'

function tmpBase(): string {
  return mkdtempSync(join(tmpdir(), 'core-dd-'))
}

describe('core data dir', () => {
  it('imports a legacy store once and never re-imports', () => {
    const base = tmpBase()
    const legacy = join(base, 'conductor-data', 'store.json')
    mkdirSync(join(base, 'conductor-data'), { recursive: true })
    writeFileSync(legacy, '{"schema":2,"repos":[]}', 'utf8')
    const v2 = join(resolveCoreDataDir(base), 'store.json')

    expect(importLegacyStoreOnce(base)).toBe(true)
    expect(JSON.parse(readFileSync(v2, 'utf8')).schema).toBe(2)
    expect(existsSync(join(resolveCoreDataDir(base), '.migrated-from'))).toBe(true)

    // The operator's v2 store diverges; a second import must NOT clobber it.
    writeFileSync(v2, '{"schema":2,"repos":[{"id":"x"}]}', 'utf8')
    expect(importLegacyStoreOnce(base)).toBe(false)
    expect(JSON.parse(readFileSync(v2, 'utf8')).repos).toHaveLength(1)
  })

  it('is a no-op when there is no legacy store', () => {
    expect(importLegacyStoreOnce(tmpBase())).toBe(false)
  })
})

describe('core single-instance lock', () => {
  it('allows one holder and reclaims a stale lock', () => {
    const dir = resolveCoreDataDir(tmpBase())
    const a = acquireLock(dir)
    expect(a).not.toBeNull()
    // A second acquire while a LIVE holder exists is refused.
    expect(acquireLock(dir)).toBeNull()
    releaseLock(a!)
    // After release a fresh acquire succeeds.
    const b = acquireLock(dir)
    expect(b).not.toBeNull()
    releaseLock(b!)
    // A lock left by a dead pid is reclaimed rather than deadlocking.
    writeFileSync(join(dir, 'core.lock'), JSON.stringify({ pid: 2147483646, startedAt: 0 }), 'utf8')
    const c = acquireLock(dir)
    expect(c).not.toBeNull()
    releaseLock(c!)
  })
})
