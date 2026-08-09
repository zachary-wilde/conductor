// Domain contract for the Operations Core automation subsystem (Release A).
//
// Everything here is pure data. The engine and ledger that consume these types
// inject `now` (epoch ms) rather than reading the clock, so occurrence timing
// and state transitions are deterministic and unit-testable — the same
// convention the insights subsystem uses.
//
// Timing model of record: a 5-field cron expression plus an IANA timezone.
// Daylight-saving correctness is obtained via Intl.DateTimeFormat with the
// stored timezone; no new npm dependency is introduced.

import type { HarnessId, RavelRole } from '@shared/types'

/** Epoch milliseconds. Aliased for intent at call sites. */
export type EpochMs = number

/** IANA timezone id, e.g. "America/Toronto". */
export type TimeZoneId = string

/** Standard 5-field cron: "minute hour day-of-month month day-of-week". */
export interface CronSpec {
  /** The raw 5-field expression, canonical timing source. */
  expression: string
  /** IANA timezone the expression is evaluated in. */
  timezone: TimeZoneId
}

export type AutomationKind = 'heartbeat' | 'schedule'

/**
 * Whether the automation may be running more than one occurrence at once.
 * Release A ships single-flight only: one automation never overlaps itself.
 * The field exists so the persisted model does not have to change if a future
 * release adds a bounded-parallel policy.
 */
export type ConcurrencyPolicy = 'single-flight'

/** How an automation decides it is finished. */
export type StopCondition =
  | { kind: 'max-runs'; runs: number }
  | { kind: 'end-timestamp'; at: EpochMs }
  | { kind: 'target-terminal' }
  | { kind: 'until-disabled' }

/** Who created a revision and whether an operator has approved it. */
export interface ApprovalMetadata {
  createdBy: 'operator' | 'agent'
  createdAt: EpochMs
  /** Present only once an operator has approved this exact revision. */
  approvedAt: EpochMs | null
}

/**
 * An immutable revision of an automation. A material edit creates a new
 * revision; the previously approved revision stays active until the
 * replacement is approved or the operator disables the automation.
 */
export interface AutomationRevision {
  id: string
  kind: AutomationKind
  title: string
  enabled: boolean
  cadence: CronSpec
  /**
   * For a heartbeat: the id of the existing Ravel or ordinary AI session to
   * wake. For a schedule: null (each occurrence launches a fresh target from
   * the launch spec below).
   */
  targetId: string | null
  /** Exact prompt delivered to the target/new session. */
  prompt: string
  repoId: string
  harness: HarnessId | null
  model: string | null
  /** Ravel roster/roles when a schedule launches a Ravel; empty otherwise. */
  ravelRoster: RavelRole[]
  /** Verification command run in the occurrence's worktree, when applicable. */
  verificationCommand: string | null
  /** Estimated-token ceiling that bounds a single occurrence. */
  perRunTokenCeiling: number | null
  concurrency: ConcurrencyPolicy
  stopCondition: StopCondition
  approval: ApprovalMetadata
}

/**
 * A durable automation definition points at exactly one current revision.
 * History of prior revisions is kept for audit but is not part of scheduling.
 */
export interface AutomationDefinition {
  id: string
  currentRevisionId: string
  revisions: AutomationRevision[]
}

/** Occurrence lifecycle. Terminal states are the last four. */
export type OccurrenceState =
  | 'due'
  | 'claimed'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'interrupted'

export const TERMINAL_OCCURRENCE_STATES: readonly OccurrenceState[] = [
  'succeeded',
  'failed',
  'skipped',
  'interrupted'
]

/** Structured failure evidence for a failed occurrence. */
export interface OccurrenceFailure {
  reason: string
  detail?: string
}

/**
 * A single scheduled firing. Every due decision is persisted (state `due`)
 * before any agent is spawned; `operationId` makes the spawn idempotent across
 * restart and reconnect.
 */
export interface Occurrence {
  id: string
  automationId: string
  revisionId: string
  state: OccurrenceState
  /** The cadence time this occurrence represents. */
  scheduledAt: EpochMs
  startedAt: EpochMs | null
  endedAt: EpochMs | null
  /** True when this occurrence is the single catch-up after downtime. */
  isCatchUp: boolean
  /**
   * How many due times this occurrence absorbed: missed occurrences during
   * downtime plus any further due times coalesced while it was pending/active.
   */
  missedCount: number
  /** The Ravel/session run this occurrence targeted or created; null until spawn. */
  runId: string | null
  /** Client-generated idempotency key for the spawn command. */
  operationId: string
  failure: OccurrenceFailure | null
  /** Token usage recorded when the occurrence reaches a terminal state. */
  tokensUsed: number | null
}
