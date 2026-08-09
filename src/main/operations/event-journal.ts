// Bounded, rotating, append-only event journal for the Operations Core unified
// timeline (Release A).
//
// This is the JOURNAL slice of the Operations Core. It is the ONLY assigner of
// `cursor`: every append takes the next monotonic cursor, persists the event,
// and returns the sequenced NormalizedEvent. Reads replay by cursor. The
// journal is bounded — events live in fixed-size segment files, and once more
// than `maxSegments` segments are retained the oldest whole segment is dropped,
// so live coverage is always a single contiguous [firstCursor, lastCursor]
// window with no interior holes. A read whose starting cursor has rotated out
// reports an explicit gap rather than fabricating a continuous history.
//
// Durability mirrors src/main/store.ts and ./automation-store.ts exactly: each
// write goes to a `<file>.tmp-<pid>-<ts>-<uuid>` sibling and is `renameSync`d
// over the target, so a crash mid-write never leaves a half-written file. The
// monotonic-cursor guarantee survives restarts because `nextCursor` is persisted
// in meta.json AND reconciled on load against the highest cursor actually
// present in the retained segment files — the belt to meta's suspenders — so a
// reopened journal never reissues a cursor. A meta or segment file that exists
// but cannot be parsed is never silently zeroed: the error is surfaced and the
// on-disk state is left untouched, so a corrupt nextCursor can never collide.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import type {
  EventCursor,
  JournalReadResult,
  JournalSegmentRange,
  NormalizedEvent,
  UnsequencedEvent
} from './events'

/** Default events per segment file before a new segment starts. */
const DEFAULT_SEGMENT_SIZE = 500
/** Default retained segment count (~10k events at the default segment size). */
const DEFAULT_MAX_SEGMENTS = 20
/** Default cap on the number of events a single readAfter returns. */
const DEFAULT_READ_LIMIT = 1000

/** On-disk shape of meta.json: the cursor to assign next plus the retained index. */
interface JournalMeta {
  version: 1
  nextCursor: EventCursor
  segmentFirstCursors: EventCursor[]
}

/** A loaded segment: its starting cursor and the events it holds, in order. */
interface LoadedSegment {
  firstCursor: EventCursor
  events: NormalizedEvent[]
}

/**
 * Bounded, rotating, append-only event journal. The only assigner of `cursor`.
 *
 * Getters return deep copies so callers cannot mutate journal state: mutating an
 * event returned by `readAfter` or `append` never affects a subsequent read.
 * Every append persists atomically to the configured directory.
 */
export interface EventJournal {
  /**
   * Assign the next monotonic cursor to `event`, persist it, and return the
   * sequenced event. The assigned cursor strictly increases and, after a
   * reopen, resumes above the highest cursor previously persisted.
   */
  append(event: UnsequencedEvent): NormalizedEvent
  /**
   * Replay retained events whose cursor is greater than `afterCursor`, ascending
   * and capped at `limit` (default 1000). `gap` is set when the event that would
   * follow `afterCursor` has already rotated out. `latestCursor` is the newest
   * assigned cursor.
   */
  readAfter(afterCursor: EventCursor, limit?: number): JournalReadResult
  /** The [firstCursor, lastCursor] window of retained events, or null when empty. */
  range(): JournalSegmentRange | null
  /** The highest assigned cursor (0 when nothing has ever been appended). */
  latest(): EventCursor
}

const META_FILE = 'meta.json'
const SEGMENT_RE = /^segment-(\d+)\.json$/

/**
 * Validate a parsed meta.json. Structural problems are a corrupt file: the load
 * surfaces an error and the on-disk file is left untouched. `segmentFirstCursors`
 * is informational (segments are rebuilt from disk on load); an absent value is
 * tolerated, but a present-but-malformed value still fails the read rather than
 * being silently dropped.
 */
function validateMeta(parsed: unknown): JournalMeta {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('event journal meta is not an object')
  }
  const root = parsed as Record<string, unknown>
  const next = root.nextCursor
  if (typeof next !== 'number' || !Number.isFinite(next) || next < 1) {
    throw new Error('event journal meta nextCursor is invalid')
  }
  const { segmentFirstCursors } = root
  if (
    segmentFirstCursors !== undefined &&
    (!Array.isArray(segmentFirstCursors) ||
      !segmentFirstCursors.every((c) => typeof c === 'number' && Number.isFinite(c)))
  ) {
    throw new Error('event journal meta segmentFirstCursors is invalid')
  }
  return {
    version: 1,
    nextCursor: next,
    segmentFirstCursors: Array.isArray(segmentFirstCursors)
      ? (segmentFirstCursors as EventCursor[])
      : []
  }
}

/**
 * Validate a parsed segment file. A segment must be a non-empty array of events
 * whose cursors are contiguous starting at the file's firstCursor; anything less
 * is corruption and fails the read.
 */
function validateSegment(parsed: unknown, firstCursor: EventCursor): NormalizedEvent[] {
  if (!Array.isArray(parsed)) {
    throw new Error(`event journal segment ${firstCursor} is not an array`)
  }
  if (parsed.length === 0) {
    throw new Error(`event journal segment ${firstCursor} is empty`)
  }
  const out: NormalizedEvent[] = []
  for (let i = 0; i < parsed.length; i++) {
    const raw = parsed[i]
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`event journal segment ${firstCursor} event ${i} is not an object`)
    }
    const entry = raw as Record<string, unknown>
    const cursor = entry.cursor
    if (typeof cursor !== 'number' || !Number.isFinite(cursor)) {
      throw new Error(`event journal segment ${firstCursor} event ${i} has no cursor`)
    }
    if (cursor !== firstCursor + i) {
      throw new Error(`event journal segment ${firstCursor} is not contiguous at index ${i}`)
    }
    out.push(entry as unknown as NormalizedEvent)
  }
  return out
}

/** Write `text` to `file` via a temp sibling + atomic rename. */
function persistAtomicText(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const tempFile = join(
    dirname(file),
    `${basename(file)}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`
  )
  try {
    writeFileSync(tempFile, text, 'utf8')
    renameSync(tempFile, file)
  } catch (error) {
    try {
      if (existsSync(tempFile)) unlinkSync(tempFile)
    } catch {
      // Best-effort cleanup only; the target file has not been replaced.
    }
    throw error
  }
}

function persistMeta(dir: string, meta: JournalMeta): void {
  persistAtomicText(join(dir, META_FILE), JSON.stringify(meta, null, 2))
}

function persistSegment(dir: string, segment: LoadedSegment): void {
  persistAtomicText(
    join(dir, `segment-${segment.firstCursor}.json`),
    JSON.stringify(segment.events, null, 2)
  )
}

function deleteSegmentFile(dir: string, firstCursor: EventCursor): void {
  try {
    unlinkSync(join(dir, `segment-${firstCursor}.json`))
  } catch {
    // Already gone (e.g. a crash-interrupted prior rotation); not an error.
  }
}

/**
 * Create a bounded, rotating event journal backed by `dir`. `dir` may be a path
 * or a lazy resolver; the directory is read lazily on first access. `segmentSize`
 * defaults to 500 events per segment and `maxSegments` to 20 (~10k retained).
 */
export function createEventJournal(config: {
  dir: string | (() => string)
  segmentSize?: number
  maxSegments?: number
}): EventJournal {
  const dirInput = config.dir
  const resolveDir = typeof dirInput === 'function' ? dirInput : (): string => dirInput
  const segmentSize = config.segmentSize ?? DEFAULT_SEGMENT_SIZE
  const maxSegments = config.maxSegments ?? DEFAULT_MAX_SEGMENTS
  if (!Number.isInteger(segmentSize) || segmentSize < 1) {
    throw new Error('event journal segmentSize must be a positive integer')
  }
  if (!Number.isInteger(maxSegments) || maxSegments < 1) {
    throw new Error('event journal maxSegments must be a positive integer')
  }

  let segments: LoadedSegment[] = []
  let nextCursor: EventCursor = 1
  let loadError: Error | null = null
  let loaded = false

  /**
   * Load once from disk. Sets in-memory state and `loadError` but never throws.
   * Idempotent via the `loaded` flag, matching the load-once convention of
   * src/main/store.ts and ./automation-store.ts.
   */
  const attemptLoad = (): void => {
    if (loaded) return
    loaded = true
    const dir = resolveDir()
    try {
      mkdirSync(dir, { recursive: true })

      let metaNextCursor: EventCursor | undefined
      const metaPath = join(dir, META_FILE)
      if (existsSync(metaPath)) {
        // A present-but-unparseable meta is surfaced, never silently zeroed.
        metaNextCursor = validateMeta(JSON.parse(readFileSync(metaPath, 'utf8'))).nextCursor
      }

      // Segments are rebuilt from disk so the journal self-heals orphaned files
      // and a stale meta index can never hide or fabricate retained events.
      const found: LoadedSegment[] = []
      for (const name of readdirSync(dir)) {
        const match = SEGMENT_RE.exec(name)
        if (!match) continue
        const firstCursor = Number.parseInt(match[1], 10)
        const events = validateSegment(
          JSON.parse(readFileSync(join(dir, name), 'utf8')),
          firstCursor
        )
        found.push({ firstCursor, events })
      }
      found.sort((a, b) => a.firstCursor - b.firstCursor)

      // Enforce the retention bound: drop oldest whole segments (and their
      // files) if a crash left more on disk than maxSegments allows.
      let trimmed = false
      while (found.length > maxSegments) {
        const dropped = found.shift()!
        deleteSegmentFile(dir, dropped.firstCursor)
        trimmed = true
      }

      // nextCursor is the max of meta's persisted value and what the retained
      // segments prove was assigned. The newest segment always holds the global
      // max cursor (rotation drops oldest only), so this never reissues a cursor
      // — even if meta lagged a write that a segment file already recorded.
      const lastSeg = found[found.length - 1]
      const derivedNext =
        found.length === 0 ? 1 : lastSeg.events[lastSeg.events.length - 1].cursor + 1
      nextCursor = Math.max(metaNextCursor ?? 1, derivedNext)
      segments = found

      // Self-heal meta when it was missing or fell behind reality.
      if (!existsSync(metaPath) || trimmed || (metaNextCursor ?? 1) !== nextCursor) {
        persistMeta(dir, {
          version: 1,
          nextCursor,
          segmentFirstCursors: segments.map((s) => s.firstCursor)
        })
      }

      loadError = null
    } catch (error) {
      segments = []
      nextCursor = 1
      loadError = new Error(
        `failed to load event journal: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  /** Ensure a healthy load, throwing the cached load error otherwise. */
  const requireLoaded = (): void => {
    attemptLoad()
    if (loadError) throw loadError
  }

  return {
    append: (event: UnsequencedEvent): NormalizedEvent => {
      requireLoaded()
      const dir = resolveDir()
      const cursor = nextCursor
      const sequenced: NormalizedEvent = { ...structuredClone(event), cursor }

      let last = segments[segments.length - 1]
      if (!last || last.events.length >= segmentSize) {
        last = { firstCursor: cursor, events: [] }
        segments.push(last)
      }
      last.events.push(sequenced)
      nextCursor = cursor + 1

      persistSegment(dir, last)
      while (segments.length > maxSegments) {
        const dropped = segments.shift()!
        deleteSegmentFile(dir, dropped.firstCursor)
      }
      persistMeta(dir, {
        version: 1,
        nextCursor,
        segmentFirstCursors: segments.map((s) => s.firstCursor)
      })

      return structuredClone(sequenced)
    },

    readAfter: (afterCursor: EventCursor, limit = DEFAULT_READ_LIMIT): JournalReadResult => {
      requireLoaded()
      const latestCursor = nextCursor - 1
      if (segments.length === 0) {
        return { events: [], latestCursor: 0, gap: null }
      }
      const earliest = segments[0].firstCursor
      const gap =
        afterCursor + 1 < earliest
          ? { requestedAfter: afterCursor, earliestAvailable: earliest }
          : null
      // Segments are sorted ascending and internally contiguous, so a single
      // pass yields globally ascending cursors.
      const events: NormalizedEvent[] = []
      if (limit > 0) {
        for (const segment of segments) {
          for (const evt of segment.events) {
            if (evt.cursor <= afterCursor) continue
            events.push(structuredClone(evt))
            if (events.length >= limit) break
          }
          if (events.length >= limit) break
        }
      }
      return { events, latestCursor, gap }
    },

    range: (): JournalSegmentRange | null => {
      requireLoaded()
      if (segments.length === 0) return null
      const first = segments[0]
      const lastSeg = segments[segments.length - 1]
      return {
        firstCursor: first.firstCursor,
        lastCursor: lastSeg.events[lastSeg.events.length - 1].cursor
      }
    },

    latest: (): EventCursor => {
      requireLoaded()
      return nextCursor - 1
    }
  }
}
