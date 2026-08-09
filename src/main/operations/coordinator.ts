// COORDINATOR slice of the Operations Core: a PURE tick planner.
//
// Given the automation definitions, the durable occurrence history, and a
// [lastCheckedAt, now] window, planAutomationTick decides — without touching
// the filesystem or spawning anything — which occurrences must be written and
// which are clear to launch. The engine supplies due times, the ledger folds
// them into the single-flight view, and this module sequences the two and
// classifies the results.
//
// Nothing here reads the system clock, the filesystem, or any module-level
// mutable state, and it never imports the store. Identifiers come from the
// injected makeId / makeOperationId, so a tick is fully reproducible for tests.

import { dueOccurrencesSince } from './automation-engine'
import { coalesceDue } from './occurrence-ledger'
import { TERMINAL_OCCURRENCE_STATES } from './types'
import type {
  AutomationDefinition,
  AutomationRevision,
  EpochMs,
  Occurrence
} from './types'

/**
 * Resolve the current (approved) revision of a definition. Every scheduling
 * decision keys off `currentRevisionId`; prior revisions are audit-only.
 */
function currentRevision(def: AutomationDefinition): AutomationRevision {
  const revision = def.revisions.find((r) => r.id === def.currentRevisionId)
  if (!revision) {
    throw new Error(
      `AutomationDefinition ${def.id} points at missing revision ${def.currentRevisionId}`
    )
  }
  return revision
}

/**
 * Whether an automation's CURRENT revision has met its stop condition against
 * the given occurrence history. Independent of the `enabled` flag: an
 * `until-disabled` automation is never exhausted here (only disabling it stops
 * it), and a disabled automation still reports exhaustion honestly so callers
 * can tell "done" apart from "paused".
 *
 * - `max-runs`        — exhausted once `runs` `succeeded` occurrences exist for
 *                       this automation (failures, skips, interrupts do not
 *                       count toward the quota).
 * - `end-timestamp`   — exhausted at and after the deadline (`now >= at`).
 * - `target-terminal` — exhausted once ANY terminal occurrence exists for it.
 * - `until-disabled`  — never exhausted by the stop condition alone.
 *
 * Pure.
 */
export function isAutomationExhausted(
  def: AutomationDefinition,
  occurrences: readonly Occurrence[],
  now: EpochMs
): boolean {
  const stop = currentRevision(def).stopCondition
  switch (stop.kind) {
    case 'max-runs': {
      const succeeded = occurrences.filter(
        (o) => o.automationId === def.id && o.state === 'succeeded'
      ).length
      return succeeded >= stop.runs
    }
    case 'end-timestamp':
      return now >= stop.at
    case 'target-terminal':
      return occurrences.some(
        (o) => o.automationId === def.id && TERMINAL_OCCURRENCE_STATES.includes(o.state)
      )
    case 'until-disabled':
      return false
  }
}

/** Input to {@link planAutomationTick}. */
export interface PlanAutomationTickInput {
  definitions: readonly AutomationDefinition[]
  occurrences: readonly Occurrence[]
  /** Exclusive lower bound of the tick window (the previous tick's `now`). */
  lastCheckedAt: EpochMs
  /** Inclusive upper bound of the tick window; also the exhaustion `now`. */
  now: EpochMs
  /** Source of a fresh occurrence id; called at most once per new occurrence. */
  makeId: () => string
  /** Source of a fresh spawn idempotency key; called once per due automation. */
  makeOperationId: () => string
}

/** A spawnable occurrence paired with the revision it would run under. */
export interface SpawnableOccurrence {
  occurrence: Occurrence
  revision: AutomationRevision
}

/** Result of a single tick: what to persist and what is clear to launch. */
export interface AutomationPlan {
  /** Every occurrence to upsert — folded-existing and freshly-created alike. */
  upserts: Occurrence[]
  /**
   * Occurrences that have NO active (non-terminal) sibling and are therefore
   * clear to be claimed and spawned under single-flight. Each carries the
   * revision whose prompt/limits govern the run.
   */
  spawnable: SpawnableOccurrence[]
}

/**
 * Decide what the automation engine should do at `now`, given the durable state
 * and the tick window `(lastCheckedAt, now]`.
 *
 * For each definition whose current revision is `enabled` and not exhausted:
 *
 * 1. resolve the current revision;
 * 2. enumerate its due fire times in the window via the engine;
 * 3. locate its single active (non-terminal) occurrence, if any;
 * 4. fold the due times into the single-flight view via the ledger, flagging a
 *    catch-up when there is no active occurrence yet multiple fires were missed.
 *
 * Every produced occurrence (existing-folded or new) is collected into
 * `upserts`. A produced `due` occurrence with no active sibling is clear to
 * launch and is also returned in `spawnable`. Disabled or exhausted automations
 * contribute nothing. Pure — the only nondeterminism is the injected id sources.
 */
export function planAutomationTick(input: PlanAutomationTickInput): AutomationPlan {
  const upserts: Occurrence[] = []
  const spawnable: SpawnableOccurrence[] = []

  for (const def of input.definitions) {
    const revision = currentRevision(def)
    if (!revision.enabled) continue
    if (isAutomationExhausted(def, input.occurrences, input.now)) continue

    const dueTimes = dueOccurrencesSince(revision.cadence, input.lastCheckedAt, input.now)
    if (dueTimes.length === 0) continue

    const active =
      input.occurrences.find(
        (o) => o.automationId === def.id && !TERMINAL_OCCURRENCE_STATES.includes(o.state)
      ) ?? null

    const { occurrence } = coalesceDue(active, dueTimes, {
      automationId: def.id,
      revisionId: revision.id,
      operationId: input.makeOperationId(),
      makeId: input.makeId,
      isCatchUp: active === null && dueTimes.length > 1
    })

    if (!occurrence) continue

    upserts.push(occurrence)
    // Single-flight: with no active occurrence there is nothing already
    // running/claimed, so this fresh `due` occurrence is clear to launch.
    if (active === null) {
      spawnable.push({ occurrence, revision })
    }
  }

  return { upserts, spawnable }
}
