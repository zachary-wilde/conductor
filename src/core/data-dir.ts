// Foundational lifecycle helpers for the standalone Conductor Core process.
//
// The Core owns a VERSIONED data directory (`conductor-data/v2`) so an older
// in-process Electron build can never rewrite the Core-owned store in its own
// shape: the legacy `conductor-data/store.json` is imported ONCE and then left
// untouched as the migration source. A single-instance lock guarantees exactly
// one Core writes that directory at a time; a stale lock (its holder no longer
// alive) is reclaimed rather than deadlocking a fresh start.
//
// Deliberately Electron-free: the Core is a plain Node process, and these
// helpers take an explicit `base` (the platform userData dir) so they are
// unit-testable against a temp directory with no app singletons.

import { copyFileSync, existsSync, mkdirSync, openSync, closeSync, writeSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

/** The Core-owned, versioned data directory under a platform userData `base`. */
export function resolveCoreDataDir(base: string): string {
  return join(base, 'conductor-data', 'v2')
}

/**
 * Import the legacy (v1, in-process-Electron) store into the versioned Core
 * directory exactly once. Returns true when an import happened, false when the
 * v2 store already exists (never overwrite the Core's live data) or there is no
 * legacy store to import. A `.migrated-from` marker records the source so the
 * one-time nature is auditable.
 */
export function importLegacyStoreOnce(base: string): boolean {
  const v2Dir = resolveCoreDataDir(base)
  const v2Store = join(v2Dir, 'store.json')
  if (existsSync(v2Store)) return false

  const legacy = join(base, 'conductor-data', 'store.json')
  if (!existsSync(legacy)) return false

  mkdirSync(v2Dir, { recursive: true })
  copyFileSync(legacy, v2Store)
  // Automations are durable operator config; carry them across too. The event
  // journal is a bounded, rotating cache, so it is intentionally left to start
  // fresh in the versioned dir rather than migrated.
  const legacyAutomations = join(base, 'conductor-data', 'automations.json')
  if (existsSync(legacyAutomations)) copyFileSync(legacyAutomations, join(v2Dir, 'automations.json'))
  writeFileSync(join(v2Dir, '.migrated-from'), JSON.stringify({ from: legacy, at: Date.now() }, null, 2), 'utf8')
  return true
}

/** A held single-instance lock; pass it back to {@link releaseLock}. */
export interface CoreLock {
  file: string
  pid: number
}

interface LockRecord {
  pid: number
  startedAt: number
}

/** Whether a process id is currently alive (signal 0 probes without killing). */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but is owned by someone else — still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Atomically create `core.lock` for this process; returns false if it already existed. */
function writeLockExclusive(lockFile: string): boolean {
  try {
    const fd = openSync(lockFile, 'wx')
    try {
      const record: LockRecord = { pid: process.pid, startedAt: Date.now() }
      writeSync(fd, JSON.stringify(record))
    } finally {
      closeSync(fd)
    }
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
}

/**
 * Acquire the single-instance lock for `dir`. Returns a {@link CoreLock} when
 * this process now holds it, or null when a LIVE holder already does. A lock
 * left by a dead process is reclaimed. Callers treat null as "a healthy Core is
 * already running here — connect to it instead of starting another".
 */
export function acquireLock(dir: string): CoreLock | null {
  mkdirSync(dir, { recursive: true })
  const lockFile = join(dir, 'core.lock')

  if (writeLockExclusive(lockFile)) return { file: lockFile, pid: process.pid }

  // The lock exists: reclaim it only if its holder is gone.
  let holder: LockRecord | null = null
  try {
    holder = JSON.parse(readFileSync(lockFile, 'utf8')) as LockRecord
  } catch {
    holder = null // unreadable/corrupt lock — treat as stale
  }
  if (holder && pidAlive(holder.pid)) return null

  try {
    unlinkSync(lockFile)
  } catch {
    /* another starter may have reclaimed it first */
  }
  return writeLockExclusive(lockFile) ? { file: lockFile, pid: process.pid } : null
}

/** Release a lock this process owns. A lock owned by someone else is left alone. */
export function releaseLock(lock: CoreLock): void {
  if (lock.pid !== process.pid) return
  try {
    const holder = JSON.parse(readFileSync(lock.file, 'utf8')) as LockRecord
    if (holder.pid === process.pid) unlinkSync(lock.file)
  } catch {
    /* already gone or unreadable */
  }
}
