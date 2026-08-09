// SCHEDULER RUNTIME: the impure driver that makes automations actually fire.
//
// The pure layers decide WHAT to do — `scheduler.ts` (planSchedulerTick +
// nextWakeAt) folds cadence math + the ledger + single-flight into a tick plan,
// and `automation-launch.ts` maps an approved revision to a launch action. This
// module owns the SIDE EFFECTS the pure layers cannot: a single next-occurrence
// timer, durable occurrence persistence, spawning a Ravel / waking a target, and
// restart reconciliation.
//
// Design invariants:
// - "Idle costs nothing": there is at most one timer, armed to the NEXT due
//   occurrence (or none when nothing is scheduled). No polling.
// - Claim-per-tick: a due occurrence is persisted, then claimed, then spawned in
//   the same tick, so single-flight (enforced by planAutomationTick) holds and a
//   due occurrence never strands.
// - Durable + idempotent: every state change is persisted immediately; because a
//   spawned occurrence is non-terminal, the next tick's planAutomationTick sees an
//   active sibling and never double-spawns. `lastCheckedAt` is persisted so a
//   restart catches up missed fires (one coalesced catch-up per automation).
// - Crash-safe: on boot, claimed/running occurrences are reconciled to
//   `interrupted` before the first tick.

import { applyTransition, canTransition, reconcileOnRestart } from './occurrence-ledger'
import type { OccurrenceTransitionPatch } from './occurrence-ledger'
import { revisionToLaunch } from './automation-launch'
import { planSchedulerTick } from './scheduler'
import type { AutomationStore } from './automation-store'
import type { AutomationRevision, EpochMs, Occurrence } from './types'
import type { CreateRavelRequest, HarnessId } from '@shared/types'

/** Opaque timer handle from the injected timer source. */
export type TimerHandle = unknown

/** Everything the runtime needs, injected so it is unit-testable without fs/timers/spawns. */
export interface SchedulerRuntimeDeps {
  automations: AutomationStore
  now(): EpochMs
  makeId(): string
  makeOperationId(): string
  /** Persisted lower bound of the tick window; null on first ever run. */
  loadLastChecked(): EpochMs | null
  saveLastChecked(at: EpochMs): void
  /** Resolve an automation's repoId to a filesystem path, or null when unknown. */
  resolveRepoPath(repoId: string): string | null
  /** Harness used when a revision leaves harness null. */
  defaultHarness: HarnessId
  /** Create a Ravel for a scheduled occurrence; returns its id or an error. */
  createRavel(request: CreateRavelRequest): Promise<{ ravelId: string | null; error?: string }>
  /** Wake an existing target (heartbeat) by delivering the prompt. */
  wakeTarget(targetId: string, prompt: string): Promise<{ error?: string }>
  setTimer(fn: () => void, ms: number): TimerHandle
  clearTimer(handle: TimerHandle): void
  log?(message: string, error?: unknown): void
}

/** A running scheduler. */
export interface SchedulerRuntime {
  /** Reconcile on boot, run an immediate catch-up tick, and arm the timer. */
  start(): Promise<void>
  /** Disarm the timer. Does not cancel in-flight spawns. */
  stop(): void
  /** Run exactly one tick at `now`: plan, persist, spawn, re-arm. Exposed for tests. */
  runOnce(now: EpochMs): Promise<void>
  /** Correlate a settled Ravel run to its running occurrence(s) → terminal state. */
  settleRun(runId: string, ok: boolean, tokensUsed?: number): void
}

/** node's setTimeout caps at ~24.8 days; clamp so a far-future wake never overflows. */
const MAX_SLEEP_MS = 2 ** 31 - 1

export function createSchedulerRuntime(deps: SchedulerRuntimeDeps): SchedulerRuntime {
  let timer: TimerHandle | null = null
  let stopped = false

  const note = (message: string, error?: unknown): void => {
    if (deps.log) deps.log(message, error)
    else if (error) console.error(`[scheduler] ${message}`, error)
  }

  const persist = (occ: Occurrence): void => deps.automations.putOccurrence(occ)

  /** Move an occurrence to `to` if the edge is legal, persist, and return the new record. */
  const transition = (
    occ: Occurrence,
    to: Occurrence['state'],
    at: EpochMs,
    patch?: OccurrenceTransitionPatch
  ): Occurrence => {
    const next = applyTransition(occ, to, at, patch)
    persist(next)
    return next
  }

  /** Persist the due occurrence, claim it, then spawn/wake per its revision. */
  async function launch(occurrence: Occurrence, revision: AutomationRevision, now: EpochMs): Promise<void> {
    const repoPath = deps.resolveRepoPath(revision.repoId)
    const action = revisionToLaunch(revision, { repoPath: repoPath ?? '', defaultHarness: deps.defaultHarness })

    if (action.kind === 'spawn-ravel' && !repoPath) {
      transition(occurrence, 'skipped', now, { failure: { reason: 'repo-not-found', detail: revision.repoId } })
      return
    }

    const claimed = transition(occurrence, 'claimed', now)
    try {
      if (action.kind === 'spawn-ravel') {
        const res = await deps.createRavel(action.request)
        if (res.ravelId) {
          transition(claimed, 'running', deps.now(), { runId: res.ravelId })
        } else {
          transition(claimed, 'failed', deps.now(), { failure: { reason: 'spawn-failed', detail: res.error } })
        }
      } else {
        const res = await deps.wakeTarget(action.targetId, action.prompt)
        if (res.error) {
          transition(claimed, 'failed', deps.now(), { failure: { reason: 'wake-failed', detail: res.error } })
        } else {
          // A heartbeat wake is a single delivered message: running → succeeded at once.
          const running = transition(claimed, 'running', deps.now(), { runId: action.targetId })
          transition(running, 'succeeded', deps.now())
        }
      }
    } catch (error) {
      note('launch failed', error)
      // `claimed` may already be persisted; only move to failed if still legal.
      if (canTransition('claimed', 'failed')) {
        transition(claimed, 'failed', deps.now(), {
          failure: { reason: 'launch-threw', detail: error instanceof Error ? error.message : String(error) }
        })
      }
    }
  }

  function arm(nextWakeAt: EpochMs | null, now: EpochMs): void {
    if (timer !== null) {
      deps.clearTimer(timer)
      timer = null
    }
    if (stopped || nextWakeAt === null) return
    const delay = Math.min(MAX_SLEEP_MS, Math.max(0, nextWakeAt - now))
    timer = deps.setTimer(() => {
      void runOnce(deps.now())
    }, delay)
  }

  async function runOnce(now: EpochMs): Promise<void> {
    if (stopped) return
    const definitions = deps.automations.listDefinitions()
    const occurrences = deps.automations.listOccurrences()
    const lastCheckedAt = deps.loadLastChecked() ?? now

    let tick
    try {
      tick = planSchedulerTick({
        definitions,
        occurrences,
        lastCheckedAt,
        now,
        makeId: deps.makeId,
        makeOperationId: deps.makeOperationId
      })
    } catch (error) {
      note('planSchedulerTick failed', error)
      return
    }

    // Persist created/folded occurrences first (durable `due` before any spawn).
    for (const occ of tick.upserts) persist(occ)
    deps.saveLastChecked(now)

    // Claim + spawn each single-flight-clear occurrence.
    for (const { occurrence, revision } of tick.spawnable) {
      // Re-read the persisted occurrence so its state is current (it was just upserted).
      const current = deps.automations.getOccurrence(occurrence.id) ?? occurrence
      if (current.state !== 'due') continue
      await launch(current, revision, now)
    }

    arm(tick.nextWakeAt, now)
  }

  return {
    async start() {
      stopped = false
      const at = deps.now()
      for (const occ of reconcileOnRestart(deps.automations.listOccurrences(), at)) {
        // reconcileOnRestart returns the full list; persist only the ones it changed.
        const prior = deps.automations.getOccurrence(occ.id)
        if (prior && prior.state !== occ.state) persist(occ)
      }
      await runOnce(at)
    },
    stop() {
      stopped = true
      if (timer !== null) {
        deps.clearTimer(timer)
        timer = null
      }
    },
    runOnce,
    settleRun(runId, ok, tokensUsed) {
      const at = deps.now()
      for (const occ of deps.automations.listOccurrences()) {
        if (occ.runId !== runId || occ.state !== 'running') continue
        transition(occ, ok ? 'succeeded' : 'failed', at, {
          failure: ok ? undefined : { reason: 'run-failed' },
          tokensUsed: tokensUsed ?? occ.tokensUsed ?? null
        })
      }
    }
  }
}
