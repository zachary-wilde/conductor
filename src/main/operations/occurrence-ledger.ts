// Occurrence state machine, idempotency, and single-flight coalescing.
//
// The LEDGER slice of the Operations Core: it consumes due-time arrays (the
// ENGINE slice's output) and owns Occurrence records — their state, the
// transitions between states, and the rule that an automation never runs two
// non-terminal occurrences at once.
//
// Every function here is pure. `now` (epoch ms) is always a parameter; nothing
// reads the system clock, the filesystem, or any module-level mutable state.
// That is the same convention the insights subsystem uses, and it makes the
// ledger deterministic and unit-testable.

import { TERMINAL_OCCURRENCE_STATES } from './types'
import type { EpochMs, Occurrence, OccurrenceState } from './types'

/**
 * Allowed forward edges of the occurrence lifecycle.
 *
 * `claimed` is mandatory before `running`: an occurrence is never spawned
 * directly out of `due`. Once terminal, an occurrence never moves again. A
 * static table keyed by the fixed `OccurrenceState` union.
 */
const TRANSITIONS: Record<OccurrenceState, Partial<Record<OccurrenceState, true>>> = {
  due: { claimed: true, skipped: true },
  claimed: { running: true, skipped: true },
  running: { succeeded: true, failed: true, interrupted: true },
  succeeded: {},
  failed: {},
  skipped: {},
  interrupted: {}
}

/**
 * Whether an occurrence may move from one state to another.
 *
 * Pure. Allowed edges: `due→claimed`, `claimed→running`, `claimed→skipped`,
 * `running→succeeded|failed|interrupted`, and `due→skipped`. No edge leaves a
 * terminal state, and `running` is reachable only through `claimed` (there is
 * no `due→running` edge). A self-transition (`from === to`) is not allowed.
 */
export function canTransition(from: OccurrenceState, to: OccurrenceState): boolean {
  return TRANSITIONS[from][to] === true
}

/**
 * The subset of `Occurrence` fields a transition may carry.
 *
 * `runId` is stamped when the spawn lands (`claimed`/`running`); `failure` and
 * `tokensUsed` are stamped on a terminal transition. These are the only fields
 * a state change is permitted to set.
 */
export type OccurrenceTransitionPatch = Partial<
  Pick<Occurrence, 'runId' | 'failure' | 'tokensUsed'>
>

/**
 * Apply a state transition, returning a NEW occurrence — the input is never
 * mutated. Throws if `canTransition(occ.state, to)` is false.
 *
 * `startedAt` is stamped the moment an occurrence moves to `running`; `endedAt`
 * is stamped on any terminal transition (`succeeded`, `failed`, `skipped`,
 * `interrupted`). Any fields in `patch` (typically `runId`, `failure`,
 * `tokensUsed`) override the carried-over values. Pure.
 */
export function applyTransition(
  occ: Occurrence,
  to: OccurrenceState,
  at: EpochMs,
  patch?: OccurrenceTransitionPatch
): Occurrence {
  if (!canTransition(occ.state, to)) {
    throw new Error(`Illegal occurrence transition: ${occ.state} → ${to}`)
  }

  const next: Occurrence = { ...occ, state: to }
  if (to === 'running') next.startedAt = at
  if (TERMINAL_OCCURRENCE_STATES.includes(to)) next.endedAt = at
  if (patch) Object.assign(next, patch)
  return next
}

/** Input to {@link coalesceDue}: how to identify a freshly created occurrence. */
export interface CoalesceOptions {
  automationId: string
  revisionId: string
  /** Idempotency key stamped onto any new occurrence. */
  operationId: string
  /** Source of a fresh occurrence id; called at most once per new occurrence. */
  makeId: () => string
  /** Whether the new occurrence is the single catch-up after downtime. */
  isCatchUp: boolean
}

/** Why (and whether) `coalesceDue` produced an occurrence. */
export type CoalesceOutcome = 'existing' | 'new' | 'none'

/**
 * Fold a set of due times into the single-flight view of an automation.
 *
 * An automation in `single-flight` concurrency never has two non-terminal
 * occurrences: while one is `due`/`claimed`/`running`, every further due time
 * is absorbed by bumping that occurrence's `missedCount`. Returns:
 *
 * - `'none'`     — `dueTimes` is empty; nothing is due, no occurrence returned.
 * - `'existing'` — `active` is a non-terminal occurrence; it is returned (new
 *                  object) with `missedCount` increased by `dueTimes.length`.
 * - `'new'`      — `active` is `null` or terminal and at least one time is due;
 *                  one new `due` occurrence is created, scheduled at the
 *                  EARLIEST due time, with `missedCount = dueTimes.length - 1`
 *                  (the surplus beyond the single time it represents).
 *
 * `makeId` is called only on the `'new'` path. Pure.
 */
export function coalesceDue(
  active: Occurrence | null,
  dueTimes: readonly EpochMs[],
  opts: CoalesceOptions
): { occurrence: Occurrence | null; coalescedInto: CoalesceOutcome } {
  if (dueTimes.length === 0) {
    return { occurrence: null, coalescedInto: 'none' }
  }

  if (active !== null && !TERMINAL_OCCURRENCE_STATES.includes(active.state)) {
    return {
      occurrence: { ...active, missedCount: active.missedCount + dueTimes.length },
      coalescedInto: 'existing'
    }
  }

  const scheduledAt = dueTimes.reduce(
    (earliest, t) => (t < earliest ? t : earliest),
    dueTimes[0]
  )

  const occurrence: Occurrence = {
    id: opts.makeId(),
    automationId: opts.automationId,
    revisionId: opts.revisionId,
    state: 'due',
    scheduledAt,
    startedAt: null,
    endedAt: null,
    isCatchUp: opts.isCatchUp,
    missedCount: dueTimes.length - 1,
    runId: null,
    operationId: opts.operationId,
    failure: null,
    tokensUsed: null
  }
  return { occurrence, coalescedInto: 'new' }
}

/**
 * Idempotent registry lookup-or-compute.
 *
 * If `operationId` is already present, the stored result is returned WITHOUT
 * calling `compute`. Otherwise `compute` is called once, its result is stored,
 * and returned. This is what makes a retried spawn safe: the second invocation
 * gets the first invocation's result and never re-runs the work. Pure with
 * respect to its arguments (it mutates the caller-owned `registry` by design).
 */
export function registerOperation<T>(
  registry: Map<string, T>,
  operationId: string,
  compute: () => T
): T {
  if (registry.has(operationId)) {
    return registry.get(operationId) as T
  }
  const result = compute()
  registry.set(operationId, result)
  return result
}

/**
 * Recover occurrence state after a core restart.
 *
 * After a crash the outcome of any in-flight occurrence is unknown: a
 * `claimed`/`running` occurrence may have finished, failed, or never advanced.
 * Rather than guess, it is marked `interrupted` with `endedAt = at` and
 * `failure.reason = 'core-restart'`. `due` occurrences (never started) and
 * already-terminal occurrences are returned unchanged. An unknown outcome is
 * NEVER promoted to `succeeded`. Pure; returns a new array.
 */
export function reconcileOnRestart(
  occurrences: readonly Occurrence[],
  at: EpochMs
): Occurrence[] {
  return occurrences.map((occ) => {
    if (occ.state === 'claimed' || occ.state === 'running') {
      return { ...occ, state: 'interrupted', endedAt: at, failure: { reason: 'core-restart' } }
    }
    return occ
  })
}
