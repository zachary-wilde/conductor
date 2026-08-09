import type { Insight, InsightSeverity, InsightState } from '@shared/insights'
import { INSIGHT_GLOBAL_COOLDOWN_MS, INSIGHT_SEEN_LIMIT } from '@shared/insights'
import type { InsightCandidate, InsightRule, InsightSnapshot } from './types'
import { RULES } from './rules'

/**
 * Turns a snapshot into at most one thing worth saying.
 *
 * Everything here is pure: given the same snapshot and state it returns the same result,
 * with no clock, filesystem or module state involved. That is what lets the whole rule
 * set be unit-tested without Electron, and it is why there is no timer anywhere — the
 * caller decides when a real event has happened and passes `now` in.
 */

const SEVERITY_RANK: Record<InsightSeverity, number> = { critical: 0, warning: 1, info: 2 }

/** Scope and coordination problems beat cost trivia when both fire at once. */
const CATEGORY_RANK: Record<InsightCandidate['category'], number> = {
  scope: 0,
  coordination: 1,
  verification: 2,
  progress: 3,
  cost: 4
}

export function collectCandidates(
  snapshot: InsightSnapshot,
  rules: readonly InsightRule[] = RULES
): InsightCandidate[] {
  const out: InsightCandidate[] = []
  for (const rule of rules) {
    let fired = false
    try {
      fired = rule.predicate(snapshot)
    } catch {
      // A throwing rule must never take down an evaluation pass; treat it as silent.
      continue
    }
    if (!fired) continue
    try {
      const { message, dedupeKey } = rule.format(snapshot)
      if (message.trim().length === 0) continue
      out.push({
        ruleId: rule.id,
        category: rule.category,
        severity: rule.severity,
        message,
        dedupeKey
      })
    } catch {
      continue
    }
  }
  return out
}

export function rank(a: InsightCandidate, b: InsightCandidate): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category] ||
    a.ruleId.localeCompare(b.ruleId)
  )
}

export interface EvaluateResult {
  /** null when nothing new is worth saying. State is still returned, possibly pruned. */
  insight: Insight | null
  state: InsightState
}

/**
 * Apply the surfacing policy. Rejected candidates are DISCARDED, not queued: a backlog
 * of stale observations delivered late is exactly the Clippy failure mode.
 */
export function evaluate(
  snapshot: InsightSnapshot,
  state: InsightState,
  rules: readonly InsightRule[] = RULES
): EvaluateResult {
  const now = snapshot.now
  const seenKeys = new Set(state.seen.map((s) => s.dedupeKey))

  const eligible = collectCandidates(snapshot, rules)
    .filter((c) => !seenKeys.has(c.dedupeKey))
    .filter((c) => {
      const rule = rules.find((r) => r.id === c.ruleId)
      const last = state.lastShownByRule[c.ruleId]
      return rule === undefined || last === undefined || now - last >= rule.cooldownMs
    })
    .sort(rank)

  // `lastGlobalShownAt` is 0 on fresh state; that means "never spoken", not "spoke at
  // the epoch". Without this guard a brand-new profile is silent until 10 minutes of
  // wall-clock have passed since 1970, which is to say always.
  const withinGlobalCooldown =
    state.lastGlobalShownAt > 0 && now - state.lastGlobalShownAt < INSIGHT_GLOBAL_COOLDOWN_MS
  const winner = eligible[0]

  if (winner === undefined || withinGlobalCooldown) {
    return { insight: null, state }
  }

  const insight: Insight = { ...winner, shownAt: now }

  return {
    insight,
    state: {
      current: insight,
      lastGlobalShownAt: now,
      lastShownByRule: { ...state.lastShownByRule, [winner.ruleId]: now },
      // Pruned here, during a real evaluation — never on a timer.
      seen: [...state.seen, { dedupeKey: winner.dedupeKey, shownAt: now }].slice(-INSIGHT_SEEN_LIMIT)
    }
  }
}

export function dismiss(state: InsightState): InsightState {
  return state.current === null ? state : { ...state, current: null }
}
