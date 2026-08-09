// Durable persistence for the Operations Core: automation definitions and
// occurrences in their own atomic JSON file.
//
// The STORE slice of the Operations Core. It owns only durability — fs reads,
// atomic writes, and deep cloning on the way out. There is no cron math and no
// tick logic here; the engine and ledger (pure) and the coordinator (pure
// planner) do all of that. This module never imports them and performs no
// process spawning, by design.
//
// The durability approach mirrors src/main/store.ts exactly: a write goes to a
// `<file>.tmp-<pid>-<ts>-<uuid>` sibling and is `renameSync`d over the target,
// so a crash mid-write never leaves a half-written store. A file that exists
// but cannot be parsed is never overwritten by a load: the error is surfaced
// and the prior on-disk state is kept rather than being replaced with defaults
// over potentially recoverable data. A deliberate write by a caller replaces
// whatever is on disk with valid data and restores the store to a healthy
// state — that is the recovery path for an unrecoverable file.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import type { AutomationDefinition, AutomationRevision, Occurrence } from './types'

/** On-disk shape of the automation store. */
interface AutomationStoreShape {
  version: 1
  definitions: AutomationDefinition[]
  occurrences: Occurrence[]
}

/**
 * Durable store for automation definitions and occurrences.
 *
 * Getters return deep copies so callers cannot mutate cached state: mutating an
 * object returned by a getter never affects a subsequent read. Every mutating
 * operation persists atomically to the configured file.
 */
export interface AutomationStore {
  /** The error from the last load attempt, or null when the file is healthy. */
  getLoadError(): Error | null
  listDefinitions(): AutomationDefinition[]
  getDefinition(id: string): AutomationDefinition | null
  /** Insert or replace a whole definition. Persists atomically. */
  putDefinition(def: AutomationDefinition): void
  /**
   * Append an immutable revision to the definition's history. Does not change
   * `currentRevisionId` — approval is a separate call.
   */
  addRevision(automationId: string, revision: AutomationRevision): void
  /**
   * Point `currentRevisionId` at an existing revision. Throws when the
   * revision id is not present on the definition.
   */
  setCurrentRevision(automationId: string, revisionId: string): void
  listOccurrences(automationId?: string): Occurrence[]
  /** Upsert an occurrence by id. Persists atomically. */
  putOccurrence(occ: Occurrence): void
  getOccurrence(id: string): Occurrence | null
}

/**
 * Canonical initial automation-store shape. One factory because three load
 * sites (initial cache, first-run create, corrupt-file fallback) must agree.
 */
function emptyStore(): AutomationStoreShape {
  return { version: 1, definitions: [], occurrences: [] }
}

/**
 * Validate a parsed store. Structural problems (root not an object, or
 * definitions/occurrences not arrays) are treated as a corrupt file: the load
 * surfaces an error and the on-disk file is left untouched.
 */
function normalizeShape(parsed: unknown): AutomationStoreShape {
  // Check the shape directly at the read boundary rather than via a generic
  // record guard: structural problems are treated as a corrupt file, so load
  // surfaces an error and the on-disk file is left untouched.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('automation store root is not an object')
  }
  const root = parsed as Record<string, unknown>
  if (!Array.isArray(root.definitions)) {
    throw new Error('automation store definitions is not an array')
  }
  if (!Array.isArray(root.occurrences)) {
    throw new Error('automation store occurrences is not an array')
  }
  return {
    // version is informational only; normalize any prior value to the current.
    version: 1,
    definitions: root.definitions as AutomationDefinition[],
    occurrences: root.occurrences as Occurrence[]
  }
}

function persistAtomic(storeFile: string, shape: AutomationStoreShape): void {
  mkdirSync(dirname(storeFile), { recursive: true })
  const tempFile = join(
    dirname(storeFile),
    `${basename(storeFile)}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`
  )
  try {
    writeFileSync(tempFile, JSON.stringify(shape, null, 2), 'utf8')
    renameSync(tempFile, storeFile)
  } catch (error) {
    try {
      if (existsSync(tempFile)) unlinkSync(tempFile)
    } catch {
      // Best effort cleanup only; the original store file has not been replaced.
    }
    throw error
  }
}

/**
 * Create a durable automation store backed by `storeFile`, mirroring
 * `createStoreForPath`'s style. `storeFile` may be a path or a lazy resolver;
 * the file is read lazily on first access.
 */
export function createAutomationStore(
  storeFileInput: string | (() => string)
): AutomationStore {
  const resolveStoreFile =
    typeof storeFileInput === 'function' ? storeFileInput : () => storeFileInput
  let cache = emptyStore()
  let loadError: Error | null = null
  let loaded = false

  /**
   * Attempt to load once. Sets `cache` and `loadError` but never throws —
   * callers that require a healthy file call `requireLoaded()` afterwards.
   * Idempotent across operations via the `loaded` flag, matching the
   * load-once-then-cache convention of src/main/store.ts.
   */
  const attemptLoad = (): void => {
    if (loaded) return
    loaded = true
    const storeFile = resolveStoreFile()
    try {
      mkdirSync(dirname(storeFile), { recursive: true })
      if (!existsSync(storeFile)) {
        cache = emptyStore()
        persistAtomic(storeFile, cache)
        loadError = null
        return
      }
      const raw = readFileSync(storeFile, 'utf8')
      const parsed = JSON.parse(raw)
      cache = normalizeShape(parsed)
      loadError = null
    } catch (error) {
      // A file we could not parse is left untouched; persisting the empty
      // cache would turn a recoverable read error into permanent loss.
      cache = emptyStore()
      loadError = new Error(
        `failed to load automation store: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  /** Ensure a healthy file, throwing the cached load error otherwise. */
  const requireLoaded = (): void => {
    attemptLoad()
    if (loadError) throw loadError
  }

  /**
   * Persist `next` atomically and adopt it as the cache. A deliberate write
   * replaces whatever was on disk with valid data, so the store becomes healthy
   * again even if the prior load failed.
   */
  const commit = (next: AutomationStoreShape): void => {
    persistAtomic(resolveStoreFile(), next)
    cache = next
    loadError = null
  }

  return {
    getLoadError: () => loadError,

    listDefinitions: (): AutomationDefinition[] => {
      requireLoaded()
      return structuredClone(cache.definitions)
    },

    getDefinition: (id: string): AutomationDefinition | null => {
      requireLoaded()
      const found = cache.definitions.find((def) => def.id === id)
      return found ? structuredClone(found) : null
    },

    putDefinition: (def: AutomationDefinition): void => {
      // A top-level upsert does not need prior data, so it proceeds even after
      // a failed load and recovers the file with the caller's valid data.
      attemptLoad()
      const next = structuredClone(cache)
      const index = next.definitions.findIndex((existing) => existing.id === def.id)
      const incoming = structuredClone(def)
      next.definitions =
        index === -1
          ? [...next.definitions, incoming]
          : next.definitions.map((existing, i) => (i === index ? incoming : existing))
      commit(next)
    },

    addRevision: (automationId: string, revision: AutomationRevision): void => {
      requireLoaded()
      const index = cache.definitions.findIndex((def) => def.id === automationId)
      if (index === -1) {
        throw new Error(`unknown automation: ${automationId}`)
      }
      const next = structuredClone(cache)
      const target = next.definitions[index]
      next.definitions[index] = {
        ...target,
        // currentRevisionId intentionally unchanged: approval is separate.
        revisions: [...target.revisions, structuredClone(revision)]
      }
      commit(next)
    },

    setCurrentRevision: (automationId: string, revisionId: string): void => {
      requireLoaded()
      const index = cache.definitions.findIndex((def) => def.id === automationId)
      if (index === -1) {
        throw new Error(`unknown automation: ${automationId}`)
      }
      const present = cache.definitions[index].revisions.some((rev) => rev.id === revisionId)
      if (!present) {
        throw new Error(`unknown revision: ${revisionId}`)
      }
      const next = structuredClone(cache)
      next.definitions[index] = {
        ...next.definitions[index],
        currentRevisionId: revisionId
      }
      commit(next)
    },

    listOccurrences: (automationId?: string): Occurrence[] => {
      requireLoaded()
      const all = structuredClone(cache.occurrences)
      return automationId === undefined
        ? all
        : all.filter((occ) => occ.automationId === automationId)
    },

    putOccurrence: (occ: Occurrence): void => {
      // A top-level upsert does not need prior data, so it proceeds even after
      // a failed load and recovers the file with the caller's valid data.
      attemptLoad()
      const next = structuredClone(cache)
      const index = next.occurrences.findIndex((existing) => existing.id === occ.id)
      const incoming = structuredClone(occ)
      next.occurrences =
        index === -1
          ? [...next.occurrences, incoming]
          : next.occurrences.map((existing, i) => (i === index ? incoming : existing))
      commit(next)
    },

    getOccurrence: (id: string): Occurrence | null => {
      requireLoaded()
      const found = cache.occurrences.find((occ) => occ.id === id)
      return found ? structuredClone(found) : null
    }
  }
}
