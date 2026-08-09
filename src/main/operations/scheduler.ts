// SCHEDULER slice of the Operations Core automation subsystem (Release A).
//
// A thin pure decision layer over the COORDINATOR. planSchedulerTick runs one
// planAutomationTick and also answers "when should the driver wake next", so the
// invasive timer+spawn runtime only has to sleep until nextWakeAt and call back.
// nextWakeAt is the earliest strictly-future cadence fire across all enabled,
// non-exhausted automations, or null when nothing is scheduled.
//
// Nothing here reads the system clock, the filesystem, or the store; the only
// nondeterminism is the injected id sources threaded through planAutomationTick.
// nextOccurrence may throw for an unschedulable cron (no fire within ~370 days);
// such an automation is skipped rather than aborting the whole scan.

import { isAutomationExhausted, planAutomationTick } from './coordinator'
import type { PlanAutomationTickInput, SpawnableOccurrence } from './coordinator'
import { nextOccurrence } from './automation-engine'
import type { AutomationDefinition, EpochMs, Occurrence } from './types'

export interface SchedulerTick {
  upserts: Occurrence[]
  spawnable: SpawnableOccurrence[]
  /** When the driver should wake next, or null when nothing is scheduled. */
  nextWakeAt: EpochMs | null
}

/**
 * Earliest future cadence fire (strictly after `after`) across enabled,
 * non-exhausted automations. A definition whose current revision is missing or
 * disabled, whose stop condition is met, or whose cron never fires is skipped.
 * Returns null when no automation contributes a fire time. Pure.
 */
export function nextWakeAt(
  definitions: readonly AutomationDefinition[],
  occurrences: readonly Occurrence[],
  after: EpochMs
): EpochMs | null {
  let earliest: EpochMs | null = null

  for (const def of definitions) {
    const revision = def.revisions.find((r) => r.id === def.currentRevisionId)
    if (!revision) continue
    if (!revision.enabled) continue
    if (isAutomationExhausted(def, occurrences, after)) continue

    let next: EpochMs
    try {
      next = nextOccurrence(revision.cadence, after)
    } catch {
      // Unschedulable expression (no fire within the engine's search cap) — skip.
      continue
    }

    if (earliest === null || next < earliest) {
      earliest = next
    }
  }

  return earliest
}

/**
 * Run one tick decision and also compute the next wake time. The next-wake
 * computation runs against the POST-tick occurrence view: `plan.upserts` are
 * upserted into `input.occurrences` by id (same-id replaces, otherwise appended)
 * so a freshly-written occurrence is visible to the exhaustion check. Pure — the
 * only nondeterminism is the injected id sources inside planAutomationTick.
 */
export function planSchedulerTick(input: PlanAutomationTickInput): SchedulerTick {
  const plan = planAutomationTick(input)
  const mergedOccurrences = mergeOccurrencesById(input.occurrences, plan.upserts)
  const wakeAt = nextWakeAt(input.definitions, mergedOccurrences, input.now)
  return { upserts: plan.upserts, spawnable: plan.spawnable, nextWakeAt: wakeAt }
}

/**
 * Fold `upserts` into `existing` by id: an existing occurrence whose id matches
 * an upsert is replaced in place (preserving position); an upsert with no
 * matching id is appended. Pure, non-mutating.
 */
function mergeOccurrencesById(
  existing: readonly Occurrence[],
  upserts: readonly Occurrence[]
): Occurrence[] {
  const byId = new Map<string, Occurrence>()
  for (const upsert of upserts) byId.set(upsert.id, upsert)

  const matched = new Set<string>()
  const merged: Occurrence[] = []
  for (const occurrence of existing) {
    const replacement = byId.get(occurrence.id)
    if (replacement) {
      matched.add(occurrence.id)
      merged.push(replacement)
    } else {
      merged.push(occurrence)
    }
  }
  for (const upsert of upserts) {
    if (!matched.has(upsert.id)) merged.push(upsert)
  }
  return merged
}
