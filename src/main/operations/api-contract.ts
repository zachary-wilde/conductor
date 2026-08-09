// Versioned client<->core protocol contract for the Operations Core.
//
// Both clients — the existing Electron renderer (Release A) and the responsive
// web client (Release B) — speak to the background core through exactly this
// contract: a request/response command+query API plus a cursor-replayed event
// stream. Defining it as one typed surface is what lets the same view models
// drive desktop and phone without a second, drifting protocol.
//
// Pure types only. No runtime, no I/O. The core implements a handler for each
// command/query; the transport (HTTP+WS in the server slice) is separate.

import type { NormalizedEvent, EventCursor, JournalReadResult } from './events'
import type {
  AutomationDefinition,
  AutomationRevision,
  Occurrence
} from './types'
import type { WorkerControlAction, WorkerControlState } from './worker-controls'
import type { DispatchVerification } from '@shared/types'

/**
 * Protocol version. Bumped only on a breaking change to the shapes below. The
 * handshake reports it so an incompatible client can read a diagnostic but is
 * refused mutation rather than corrupting state.
 */
export const API_VERSION = 1 as const

/**
 * The core's opening handshake. A client compares these against its own build
 * and refuses to mutate on an incompatible `apiVersion` or `storeSchemaVersion`.
 */
export interface CoreHandshake {
  coreVersion: string
  apiVersion: number
  storeSchemaVersion: number
  capabilities: string[]
  /** The newest event cursor at connect time, so a client knows where to replay from. */
  cursor: EventCursor
}

/**
 * Every mutating command carries a client-generated `operationId`. The core
 * persists the accepted operation and returns the prior result when the same id
 * is retried, so a reconnect cannot create two schedules, send two prompts, or
 * land a branch twice.
 */
export interface CommandEnvelope<TName extends string, TPayload> {
  operationId: string
  name: TName
  payload: TPayload
}

/** A worker-directed control command (message/pause/resume/stop/retry/archive/detach). */
export type WorkerControlCommand = CommandEnvelope<
  'worker.control',
  {
    workerId: string
    action: WorkerControlAction
    /** Present for `message`; the operator-authored follow-up text. */
    message?: string
    /** Operator confirmation for actions that require it (stop/detach/archive). */
    confirmed?: boolean
  }
>

/** Create or replace an automation definition (operator-authored). */
export type AutomationUpsertCommand = CommandEnvelope<
  'automation.upsert',
  { definition: AutomationDefinition }
>

/** Append a new immutable revision to an existing automation. */
export type AutomationAddRevisionCommand = CommandEnvelope<
  'automation.addRevision',
  { automationId: string; revision: AutomationRevision }
>

/**
 * Approve an exact revision (operator only). Binds approval to the revision id;
 * an agent-created proposal can never self-approve through this command.
 */
export type AutomationApproveCommand = CommandEnvelope<
  'automation.approve',
  { automationId: string; revisionId: string }
>

/** Enable or disable an automation's current revision. */
export type AutomationSetEnabledCommand = CommandEnvelope<
  'automation.setEnabled',
  { automationId: string; enabled: boolean }
>

/**
 * Review decision on a branch. `land` rechecks commits, digest, verification,
 * cleanliness, and conflicts immediately before invoking the safe merge; a
 * stale or dirty state refuses rather than claiming the prior preview's success.
 */
export type ReviewDecisionCommand = CommandEnvelope<
  'review.decide',
  {
    repoId: string
    branch: string
    baseCommit: string
    headCommit: string
    diffDigest: string
    decision: 'request-changes' | 'reject' | 'land'
    /** Operator message for `request-changes`; reason for `reject`. */
    note?: string
    /** Required true for `land`; and again when verification is missing/failed. */
    confirmed?: boolean
  }
>

/** The discriminated union of every mutating command. */
export type ClientCommand =
  | WorkerControlCommand
  | AutomationUpsertCommand
  | AutomationAddRevisionCommand
  | AutomationApproveCommand
  | AutomationSetEnabledCommand
  | ReviewDecisionCommand

/** Uniform command result. `deduplicated` is true when a retried operationId returned a prior result. */
export interface CommandResult<T = unknown> {
  ok: boolean
  operationId: string
  deduplicated: boolean
  value?: T
  /** Safe, client-facing error; internals stay in the core's logs. */
  error?: { code: string; message: string }
}

/** Read a page of the unified timeline by cursor (delegates to the event journal). */
export type TimelineQuery = {
  name: 'timeline.read'
  afterCursor: EventCursor
  limit?: number
}

/** A worker's full detail projection for the detail pane. */
export type WorkerDetailQuery = { name: 'worker.detail'; workerId: string }

/** List automations with their current revision and recent occurrences. */
export type AutomationListQuery = { name: 'automation.list' }

/**
 * List branches that finished work and are candidates for review/land. Additive
 * (non-breaking): older clients simply never issue it. The core resolves the
 * current base/head commits and the diff digest so the client never has to,
 * and so `review.decide`'s land recheck compares against the same values.
 */
export type ReviewListQuery = { name: 'review.list' }

/**
 * Retrieve the bounded diff for one reviewable branch. Read-only: it returns
 * the branch's CURRENT diff against its base plus the current base/head/digest,
 * so a client comparing that digest to the `review.list` item it opened can see
 * a base/head/content change without a separate staleness call.
 */
export type ReviewDiffQuery = { name: 'review.diff'; repoId: string; branch: string }

export type ClientQuery =
  | TimelineQuery
  | WorkerDetailQuery
  | AutomationListQuery
  | ReviewListQuery
  | ReviewDiffQuery

/** Projected worker detail returned by `worker.detail`. */
export interface WorkerDetailView {
  workerId: string
  controlState: WorkerControlState
  availableControls: WorkerControlAction[]
  latestEvents: NormalizedEvent[]
  /**
   * Titles of the briefs that depend on this worker's brief. Empty for a plain
   * session. A `detach` confirmation must name these (they are blocked by it),
   * so the operator never detaches dependents through an unlabeled button.
   */
  dependentBriefs: string[]
}

/** One automation's summary for `automation.list`. */
export interface AutomationListItem {
  definition: AutomationDefinition
  currentRevision: AutomationRevision
  recentOccurrences: Occurrence[]
}

/** One reviewable branch for `review.list` — everything the client needs to `review.decide`. */
export interface ReviewListItem {
  repoId: string
  ravelId: string
  briefId: string
  title: string
  branch: string
  /** Current base tip; a `land` refuses if the base has moved off this (stale-base guard). */
  baseCommit: string
  /** Current branch tip; a `land` refuses if the branch has moved off this. */
  headCommit: string
  /** Digest over (base, head, branch, changedFiles) via `review-digest`; recomputed at land time. */
  diffDigest: string
  changedFiles: string[]
  /** The dispatch's own verify verdict, when the repo has a verify command. */
  verification: DispatchVerification | null
  /** Whether the branch has work ahead of base (something to land). */
  landable: boolean
}

/**
 * How one file's diff is presented. A diff is either shown as `text`, or
 * explicitly IDENTIFIED — never silently omitted — as `binary` (not decoded),
 * `oversized` (its own patch exceeds the per-file byte limit), or `truncated`
 * (the per-review byte budget was already spent before this file). `deleted`
 * and `renamed` are carried by `status`, not here.
 */
export type ReviewDiffContent = 'text' | 'binary' | 'oversized' | 'truncated'

/** One file's bounded diff within a branch review. */
export interface ReviewFileDiff {
  path: string
  /** Rename/copy source path; null unless `status === 'renamed'`. */
  oldPath: string | null
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  /** Lines added / removed; null when the file is binary. */
  additions: number | null
  deletions: number | null
  /** Presentation state of `patch`. */
  content: ReviewDiffContent
  /** Bounded unified diff text; empty unless `content === 'text'`. */
  patch: string
}

/**
 * The bounded diff for one reviewable branch. Carries the current
 * base/head/digest so a client can detect a base/head/content change against
 * the `review.list` item it opened (spec: a change invalidates a decision
 * visibly). `truncated` is true when the per-review byte budget was hit and
 * later files are `content:'truncated'` with their metadata still present.
 */
export interface ReviewDiff {
  repoId: string
  branch: string
  baseBranch: string
  baseCommit: string
  headCommit: string
  diffDigest: string
  files: ReviewFileDiff[]
  truncated: boolean
}

/** Query result union, keyed by the query name each satisfies. */
export interface QueryResults {
  'timeline.read': JournalReadResult
  'worker.detail': WorkerDetailView
  'automation.list': AutomationListItem[]
  'review.list': ReviewListItem[]
  'review.diff': ReviewDiff
}

/**
 * A frame pushed over the event stream. `event` frames carry a normalized
 * timeline event; `gap` frames tell a reconnecting client its cursor rotated
 * out and it must resync from `earliestAvailable`.
 */
export type EventStreamFrame =
  | { type: 'event'; event: NormalizedEvent }
  | { type: 'gap'; earliestAvailable: EventCursor }
