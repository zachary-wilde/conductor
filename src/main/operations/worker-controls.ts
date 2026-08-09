// WORKER-CONTROLS slice of the Operations Core: PURE capability logic for the
// direct controls an operator can apply to a single worker (an AI session, a
// Ravel child, a Roundtable seat, etc.).
//
// This module decides two things and nothing else:
//   1. Which controls are AVAILABLE for a worker given its control-plane state.
//   2. Which of those controls REQUIRE CONFIRMATION, and whether a detach would
//      orphan the briefs that depend on the worker.
//
// It performs no I/O, reads no clock, and imports neither the journal nor the
// store. The control-plane state is supplied by the caller (the worker
// supervisor / store projects a worker into {@link WorkerControlState}), so
// every decision is a pure total function of its inputs and is unit-testable.
//
// The rules below are deliberately a fixed projection of state, not a state
// machine: this module never transitions a worker. The supervisor owns the
// transitions and re-asks for controls after each one.

import type { WorkerKind } from './events'

/**
 * The actions an operator can take against a single worker from the controls
 * surface. This union is the universe of controls; {@link availableControls}
 * narrows it to those valid for a worker's current state, and
 * {@link requiresConfirmation} flags the destructive subset.
 */
export type WorkerControlAction =
  | 'message'
  | 'pause'
  | 'resume'
  | 'stop'
  | 'retry'
  | 'archive'
  | 'detach'

/**
 * The control-plane projection of a worker's lifecycle — the states the
 * SUPERVISOR tracks, not the full session state machine.
 *
 * - `starting`        — spawned but the CLI handshake has not completed.
 * - `running`         — actively producing; the only state in which `pause`
 *                       applies.
 * - `pause-requested` — a pause was requested and is propagating to the CLI.
 *                       `resume` may cancel it, but a fresh `pause` cannot be
 *                       queued on top of a request already in flight.
 * - `paused`          — confirmed halted; `resume` lifts it.
 * - `terminal`        — the CLI process has exited (succeeded, failed, or
 *                       stopped); only `retry` and `archive` remain.
 */
export type WorkerLifecycle =
  | 'starting'
  | 'running'
  | 'pause-requested'
  | 'paused'
  | 'terminal'

/**
 * The subset of a worker's state that governs which controls are valid. The
 * worker supervisor (which owns the full state machine) projects a worker into
 * this shape before consulting the controls logic, so this module never holds
 * fields it does not need.
 *
 * `responseInFlight` and `dependentCount` are carried so future rules and the
 * UI confirmation flow have what they need without this module reaching back
 * into the supervisor.
 */
export interface WorkerControlState {
  kind: WorkerKind
  lifecycle: WorkerLifecycle
  /** An active CLI response is currently in flight (awaiting the process). */
  responseInFlight: boolean
  /** A `ravel-child` that belongs to a parent ravel; the precondition for detach. */
  hasParentRavel: boolean
  /** Count of briefs whose execution depends on this worker. */
  dependentCount: number
}

/**
 * Whether `detach` is structurally valid for a worker. Detach only ever applies
 * to a `ravel-child` that still belongs to a parent ravel and has not exited;
 * every other worker shape is permanent and offers no detach. Kept as a named
 * helper because the same three-part precondition drives both the availability
 * of `detach` and whether detaching would affect dependents.
 */
function canDetach(state: WorkerControlState): boolean {
  return state.kind === 'ravel-child' && state.hasParentRavel && state.lifecycle !== 'terminal'
}

/**
 * The controls an operator may apply to a worker in its current state, in
 * canonical display order.
 *
 * Capability rules (spec):
 * - `message` — valid for any non-terminal worker.
 * - `pause`   — valid only while `running`.
 * - `resume`  — valid only from `paused` or `pause-requested`.
 * - `stop`    — valid for any non-terminal worker.
 * - `retry`   — valid only when `terminal`.
 * - `archive` — valid only when `terminal`.
 * - `detach`  — valid only for a non-terminal `ravel-child` with a parent ravel.
 *
 * A terminal worker therefore offers exactly `retry` and `archive`.
 *
 * Pure and total: every {@link WorkerControlState} maps to a defined result.
 */
export function availableControls(state: WorkerControlState): WorkerControlAction[] {
  const terminal = state.lifecycle === 'terminal'
  const result: WorkerControlAction[] = []
  if (!terminal) result.push('message')
  if (state.lifecycle === 'running') result.push('pause')
  if (state.lifecycle === 'paused' || state.lifecycle === 'pause-requested') result.push('resume')
  if (!terminal) result.push('stop')
  if (terminal) result.push('retry')
  if (terminal) result.push('archive')
  if (canDetach(state)) result.push('detach')
  return result
}

/**
 * Whether applying `action` must be gated on an explicit operator
 * confirmation. The destructive actions — `stop`, `detach`, and `archive` —
 * require it; `message`, `pause`, `resume`, and `retry` do not.
 *
 * The rule is action-driven and unconditional, so `_state` is not consulted
 * today. It is kept (underscored, to satisfy `noUnusedParameters`) so callers
 * pass the worker's state uniformly and per-state confirmation rules can be
 * added later without changing the contract.
 *
 * Pure and total.
 */
export function requiresConfirmation(
  action: WorkerControlAction,
  _state: WorkerControlState
): boolean {
  return action === 'stop' || action === 'detach' || action === 'archive'
}

/**
 * Whether detaching this worker would affect the briefs that depend on it.
 * True only when `detach` is a valid action for the worker AND at least one
 * dependent brief exists. The UI uses this to escalate the detach confirmation
 * from a generic prompt to a named one that lists the affected dependents.
 *
 * Pure and total.
 */
export function detachAffectsDependents(state: WorkerControlState): boolean {
  return canDetach(state) && state.dependentCount > 0
}
