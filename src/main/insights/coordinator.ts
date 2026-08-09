import type { Insight, InsightState } from '@shared/insights'
import { EMPTY_INSIGHT_STATE } from '@shared/insights'
import type { PublicRavelConfig, Session } from '@shared/types'
import { evaluate, dismiss as dismissState } from './engine'
import type { InsightSnapshot, InsightTrigger } from './types'

/**
 * Owns the live insight and decides when to look.
 *
 * There is no timer here and there must never be one. `note()` is called from places
 * where something genuinely happened — a child exited, a verdict landed, a plan was
 * approved — so an app with nothing running evaluates nothing and costs nothing. That is
 * the same guarantee the Ravel manager makes, and it is easy to lose by accident.
 */

export interface CoordinatorDeps {
  loadState: () => InsightState
  saveState: (state: InsightState) => void
  emit: (insight: Insight | null) => void
  listSessions: () => Session[]
  activeRavel: (ravelId: string) => PublicRavelConfig | null
  /** Git-derived per-dispatch facts. Async and bounded; never called from a rule. */
  collectDispatches: (ravel: PublicRavelConfig | null) => Promise<InsightSnapshot['dispatches']>
  now: () => number
}

export class InsightCoordinator {
  private readonly deps: CoordinatorDeps
  /**
   * Coalesced PER RAVEL, not globally. A single in-flight flag would let one busy fleet
   * silently swallow every event from another one running beside it — which is the whole
   * point of this app.
   */
  private readonly pending = new Map<string, Promise<void>>()
  private readonly queued = new Map<string, InsightTrigger>()

  constructor(deps: CoordinatorDeps) {
    this.deps = deps
  }

  current(): Insight | null {
    return this.deps.loadState().current
  }

  dismiss(): void {
    const next = dismissState(this.deps.loadState())
    this.deps.saveState(next)
    this.deps.emit(null)
  }

  /**
   * Resolves when the evaluation started for this ravel has fully drained, queue
   * included. `note()` is deliberately fire-and-forget so no orchestration path
   * ever waits on git; this exists so a test can wait on the real signal instead
   * of sleeping and hoping.
   */
  settled(ravelId: string): Promise<void> {
    return this.pending.get(ravelId) ?? Promise.resolve()
  }

  /**
   * Record that something happened and evaluate. Safe to call often — it coalesces, it
   * never throws into the caller, and it resolves to nothing.
   */
  note(trigger: InsightTrigger, ravelId: string): void {
    if (this.pending.has(ravelId)) {
      // Keep only the latest trigger: a backlog of stale evaluations helps nobody.
      this.queued.set(ravelId, trigger)
      return
    }

    const drain = (async () => {
      let next: InsightTrigger | undefined = trigger
      while (next !== undefined) {
        await this.run(next, ravelId)
        next = this.queued.get(ravelId)
        this.queued.delete(ravelId)
      }
    })()
      .catch(() => {
        // An insight failing must never disturb the orchestration path that called it.
      })
      .finally(() => {
        this.pending.delete(ravelId)
      })

    this.pending.set(ravelId, drain)
  }

  private async run(trigger: InsightTrigger, ravelId: string): Promise<void> {
    const ravel = this.deps.activeRavel(ravelId)
    const dispatches = await this.deps.collectDispatches(ravel)

    const snapshot: InsightSnapshot = {
      now: this.deps.now(),
      trigger,
      ravel,
      sessions: this.deps.listSessions(),
      dispatches,
      roleMedianOutputTokens: medianByRole(dispatches),
      openingPromptWords: countWords(firstUserMessage(ravel))
    }

    const { insight, state } = evaluate(snapshot, this.deps.loadState() ?? EMPTY_INSIGHT_STATE)
    if (insight === null) return
    this.deps.saveState(state)
    this.deps.emit(insight)
  }
}

function firstUserMessage(ravel: PublicRavelConfig | null): string {
  return ravel?.messages.find((m) => m.author === 'user')?.body ?? ''
}

function countWords(text: string): number {
  const trimmed = text.trim()
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length
}

/** Median rather than mean: one runaway dispatch should not redefine "normal". */
export function medianByRole(
  dispatches: InsightSnapshot['dispatches']
): InsightSnapshot['roleMedianOutputTokens'] {
  const buckets = new Map<string, number[]>()
  for (const d of dispatches) {
    if (d.status !== 'completed') continue
    const list = buckets.get(d.role) ?? []
    list.push(d.usage.outputTokens)
    buckets.set(d.role, list)
  }
  const out: InsightSnapshot['roleMedianOutputTokens'] = {}
  for (const [role, values] of buckets) {
    if (values.length < 3) continue // too few to call anything typical
    const sorted = [...values].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    out[role as keyof typeof out] =
      sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid]
  }
  return out
}
