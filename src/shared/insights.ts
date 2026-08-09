/**
 * Observations the mascot surfaces about what the fleet is actually doing.
 *
 * Every insight must be derivable from state Conductor already holds. Anything that
 * would require guessing — whether a change was "polish", whether two fixes were "the
 * same fix", how far through a goal you are — is deliberately absent. A corner blob that
 * says something false is worse than one that says nothing.
 */

export type InsightCategory = 'scope' | 'coordination' | 'verification' | 'cost' | 'progress'

export type InsightSeverity = 'info' | 'warning' | 'critical'

export interface Insight {
  ruleId: string
  category: InsightCategory
  severity: InsightSeverity
  message: string
  /** Identifies the evidence, so the same observation is never repeated. */
  dedupeKey: string
  shownAt: number
}

/** Persisted so the mascot cannot repeat itself across restarts. */
export interface InsightState {
  current: Insight | null
  lastGlobalShownAt: number
  lastShownByRule: Record<string, number>
  /** Bounded ring of evidence already surfaced. */
  seen: { dedupeKey: string; shownAt: number }[]
}

export const EMPTY_INSIGHT_STATE: InsightState = {
  current: null,
  lastGlobalShownAt: 0,
  lastShownByRule: {},
  seen: []
}

/** At most one insight per this window, however many rules fire. */
export const INSIGHT_GLOBAL_COOLDOWN_MS = 10 * 60_000

export const INSIGHT_SEEN_LIMIT = 200
