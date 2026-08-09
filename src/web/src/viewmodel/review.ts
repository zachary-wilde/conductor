// Pure view-model: review-list presentation + land-confirmation logic.
//
// The `review.list` query returns everything the operator needs to act on a
// branch — commits, digest, changed files, and the dispatch's own verify
// verdict — so the review screen no longer hand-enters or recomputes any of it.
// This module holds the two PURE decisions the screen makes from a list item:
//   1. How to LABEL the item's verification verdict (the badge).
//   2. Whether LANDING it must be gated on an explicit operator confirm step.
//
// It performs no I/O, reads no clock, and imports nothing but the contract type
// — so both decisions are unit-testable and never drift from the server rule
// they mirror (the core likewise refuses a `land` without `confirmed:true`, and
// re-demands it when verification is missing or failed).

import type { DispatchVerification } from '@shared/types'

/** The three visual states a review item's verification verdict can be in. */
export type VerificationStatus = 'passed' | 'failed' | 'unverified'

/**
 * Map a dispatch's verify verdict to a badge state. `null` means the repo had
 * no verify command (the dispatch was never verified), not that a verification
 * is pending — there is no pending state in the contract.
 */
export function verificationStatus(
  verification: DispatchVerification | null
): VerificationStatus {
  if (verification === null) return 'unverified'
  return verification.ok ? 'passed' : 'failed'
}

/**
 * Whether LANDING a branch must be gated on an explicit operator confirm step.
 * Mirrors the server's `confirmed` rule for `review.decide`: a `land` is always
 * allowed through once confirmed, but the client adds a second click when the
 * branch's verification is missing OR failed, so an unverified/failed tree is
 * never landed by a single accidental press. A verified branch lands in one.
 */
export function landRequiresConfirm(
  verification: DispatchVerification | null
): boolean {
  return verification === null || !verification.ok
}
