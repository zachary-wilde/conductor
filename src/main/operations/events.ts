// Normalized event model for the Operations Core unified timeline (Release A).
//
// Every agent action across Ravels, Roundtables, and ordinary AI sessions is
// projected into ONE normalized event shape so the timeline, the client API,
// and (in Release B) the remote web client all consume the same contract.
//
// The journal that stores these events assigns each a monotonically increasing
// `cursor`. Cursors are the ONLY ordering authority: they never decrease, they
// survive segment rotation, and a client replays by asking for everything after
// a cursor it already has. When a requested cursor has rotated out of the
// bounded journal, the read reports an explicit gap rather than fabricating a
// continuous history.
//
// This module is pure data + a monotonic-cursor helper. It performs no I/O.

import type { HarnessId, RavelRole } from '@shared/types'
import type { EpochMs } from './types'

/**
 * Monotonic ordering key. A plain number: the journal issues 1, 2, 3, … in
 * assignment order and never reuses or lowers a value within a store's life.
 */
export type EventCursor = number

/** The kind of top-level workflow an event belongs to. */
export type WorkflowKind = 'ravel' | 'roundtable' | 'session'

/** The kind of worker an event was emitted by. */
export type WorkerKind =
  | 'ravel-manager'
  | 'ravel-child'
  | 'roundtable-seat'
  | 'session'

/**
 * The category of a normalized event. Mirrors the spec's event-kind list; the
 * timeline groups and filters on these without inventing relationships the
 * source data does not have.
 */
export type EventKind =
  | 'lifecycle'
  | 'conversation'
  | 'tool'
  | 'file'
  | 'commit'
  | 'verification'
  | 'approval'
  | 'rejection'
  | 'budget'
  | 'automation'
  | 'control-request'
  | 'control-result'
  | 'failure'
  | 'interruption'

/**
 * Source identifiers that tie an event back to the concrete objects that
 * produced it. Every field is optional: an event carries only the ids that
 * genuinely apply, and a missing id stays missing rather than being invented.
 */
export interface EventSourceIds {
  ravelId?: string
  briefId?: string
  sessionId?: string
  roundtableId?: string
  automationId?: string
  occurrenceId?: string
}

/**
 * A single normalized timeline event. `cursor` is assigned by the journal on
 * append; everything else is supplied by the projector that normalized the
 * source activity. Fields that are not known for a given event are `null`,
 * never guessed.
 */
export interface NormalizedEvent {
  id: string
  cursor: EventCursor
  timestamp: EpochMs
  repoId: string | null
  rootWorkflowId: string
  rootWorkflowKind: WorkflowKind
  /** The worker one level up, when this event's worker has a parent. */
  parentWorkerId: string | null
  workerId: string | null
  workerKind: WorkerKind | null
  role: RavelRole | null
  harness: HarnessId | null
  model: string | null
  /** 1-based attempt number of the worker/brief this event belongs to. */
  attempt: number
  kind: EventKind
  /** Short human summary. Detailed bytes live in the per-session log, not here. */
  summary: string
  /** References (paths/ids) to structured evidence; never inlined blobs. */
  evidenceRefs: string[]
  source: EventSourceIds
}

/** An event before the journal has assigned it a cursor. */
export type UnsequencedEvent = Omit<NormalizedEvent, 'cursor'>

/**
 * A contiguous stored range of events. Segments rotate: old ones are dropped
 * whole, so the journal's live coverage is always a single `[firstCursor,
 * lastCursor]` window with no interior holes.
 */
export interface JournalSegmentRange {
  firstCursor: EventCursor
  lastCursor: EventCursor
}

/**
 * The result of replaying from a cursor. `gap` is set when the requested cursor
 * predates the earliest retained event: the caller learns the exact earliest
 * cursor now available instead of receiving a silently truncated history.
 */
export interface JournalReadResult {
  events: NormalizedEvent[]
  /** The journal's newest assigned cursor, so a caller can detect being caught up. */
  latestCursor: EventCursor
  /**
   * Present only when the requested cursor was older than the earliest retained
   * event. `earliestAvailable` is the oldest cursor the journal can still serve.
   */
  gap: { requestedAfter: EventCursor; earliestAvailable: EventCursor } | null
}
