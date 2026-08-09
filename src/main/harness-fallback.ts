// Vendor fallback: when a manager turn's harness "runs dry" mid-run, re-point
// the Ravel at the next vendor instead of stalling.
//
// Two pure decisions live here, so the runtime wiring stays a thin loop:
//   1. classifyHarnessFailure — is a failed turn a vendor running DRY (quota,
//      rate limit, auth, or the CLI being unavailable), or an ordinary failure?
//      Only 'dry' is worth re-pointing; retrying a genuine task failure or a
//      plain timeout on another vendor just burns it too.
//   2. nextFallbackHarness — given the configured order and which vendors are
//      installed, the next one to try (never the current, never one already
//      tried this turn, never an uninstalled one).
//
// The classifier reads only the error MESSAGE because that is the sole carrier
// the CLIs give us: runHeadlessHarness throws Errors whose text is the stderr
// tail / exit summary / "is not available" string. Matching is a deliberate
// heuristic biased slightly toward 'dry' - a false 'dry' costs one retry on
// another installed vendor, while a missed 'dry' leaves the run stalled.

import type { HarnessId } from '@shared/types'

/** A manager-turn failure is either a vendor running dry (re-pointable) or not. */
export type HarnessFailureKind = 'dry' | 'other'

/**
 * Substrings (matched case-insensitively) that mean the current vendor cannot do
 * the work right now: quota/billing, rate limits, provider overload, auth/login,
 * or the CLI simply not being installed. Kept broad on purpose.
 */
const DRY_MARKERS: readonly string[] = [
  'quota',
  'rate limit',
  'rate-limit',
  'ratelimit',
  '429',
  'too many requests',
  'insufficient',
  'exhausted',
  'usage limit',
  'billing',
  'payment',
  'credit',
  'overloaded',
  '529',
  'unauthorized',
  '401',
  '403',
  'authenticat',
  'not logged in',
  'log in',
  'login',
  // resolveHarness: "<CLI> is not available. Install it ..." / raw spawn ENOENT
  'is not available',
  'not found on path',
  'enoent'
]

/**
 * Failures that are explicitly NOT a dry vendor even though they are errors: a
 * turn timeout (the model was responding, just slowly) and an operator/close
 * cancellation. Re-pointing these would loop or fight the operator.
 */
const NOT_DRY_MARKERS: readonly string[] = ['timed out', 'was cancelled', 'was canceled']

/** Classify a manager-turn failure message as a dry vendor vs. an ordinary failure. */
export function classifyHarnessFailure(message: string): HarnessFailureKind {
  const text = message.toLowerCase()
  if (NOT_DRY_MARKERS.some((marker) => text.includes(marker))) return 'other'
  return DRY_MARKERS.some((marker) => text.includes(marker)) ? 'dry' : 'other'
}

export interface FallbackChoice {
  /** The harness that just ran dry. */
  current: HarnessId
  /** Operator-configured preference order; empty disables fallback. */
  order: readonly HarnessId[]
  /** Harnesses whose CLI is actually installed right now. */
  available: ReadonlySet<HarnessId>
  /** Harnesses already attempted in this turn (includes `current`). */
  tried: ReadonlySet<HarnessId>
}

/**
 * The next vendor to try after `current` ran dry: the first entry in `order`
 * that is installed and not yet tried. `null` when the chain is exhausted, which
 * tells the caller to surface the original failure instead of re-pointing.
 */
export function nextFallbackHarness(choice: FallbackChoice): HarnessId | null {
  for (const id of choice.order) {
    if (id === choice.current) continue
    if (choice.tried.has(id)) continue
    if (!choice.available.has(id)) continue
    return id
  }
  return null
}
