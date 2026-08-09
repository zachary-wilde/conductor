// PURE view-model: the confirmation copy shown before an operator detaches a
// ravel-child worker. Detach is the one control whose confirmation must NAME the
// dependent briefs it blocks (a generic unlabeled button is not allowed when
// dependents exist). This module turns `dependentBriefs` (brief TITLES from
// `worker.detail`) into a structured, render-ready descriptor — no I/O, no clock,
// no React — so the wording is unit-testable in isolation.

/** What the Detach confirmation step renders. */
export interface DetachConfirmCopy {
  /** True when at least one non-blank dependent brief title is present. */
  hasDependents: boolean
  /**
   * Lead line. When there are dependents it warns they are BLOCKED (and how
   * many); otherwise it is the lighter standalone-session prompt.
   */
  intro: string
  /** The dependent brief titles to name (blanks dropped); empty w/o dependents. */
  dependentBriefs: string[]
  /** The effect of a detach, independent of dependents. Always the same string. */
  effect: string
}

/**
 * What detach actually does, shown on every confirmation so the operator knows
 * nothing is killed. Exposed for the view and pinned by tests.
 */
export const DETACH_EFFECT =
  'The child becomes a standalone session you control; the Ravel is asked to replan; nothing is killed.'

/**
 * Build the confirmation copy for a detach given the dependent brief titles.
 * Blank/whitespace-only titles are ignored so the confirmation never names an
 * empty slot.
 */
export function detachConfirmCopy(dependentBriefs: readonly string[]): DetachConfirmCopy {
  const deps = dependentBriefs.filter((t) => t.trim().length > 0)
  const hasDependents = deps.length > 0
  const intro = hasDependents
    ? `Detaching this worker blocks ${deps.length} dependent brief${deps.length === 1 ? '' : 's'}:`
    : 'Detach hands this running agent to you as a standalone session and asks the Ravel to replan.'
  return { hasDependents, intro, dependentBriefs: deps, effect: DETACH_EFFECT }
}
