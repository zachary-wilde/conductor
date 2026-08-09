import type { PublicRavelConfig, Session } from '@shared/types'

/**
 * What the dashboard's ring is measuring.
 *
 * The widget that used to sit here was a Pomodoro timer: a human focus tool on a
 * product whose whole claim is that the human is not the one doing the 25 minutes.
 * The number that actually matters on an idle-looking dashboard is spend against
 * the ceiling, because `tokenCeilingPerRavel` is the only thing that stops a
 * runaway child, and until now it was visible nowhere except inside a ravel.
 */
export interface FleetMeter {
  /** The ravel the ring is tracking. null when nothing has been dispatched. */
  ravel: PublicRavelConfig | null
  /** Estimated tokens that ravel has spent. Character-derived, never provider-reported. */
  spent: number
  /**
   * Spend as a fraction of the ceiling, clamped to 1 for the arc.
   * null when no ceiling is configured — an unbounded ring would be a lie.
   */
  ratio: number | null
  /** The focus ravel's estimated cost. null when no rate entry covers its model. */
  costUsd: number | null
  ravelCount: number
  /** Sessions still holding a pty. `error` sessions are dead but linger in the list. */
  liveSessionCount: number
  level: MeterLevel
  /** What the primary button may do to the focus ravel. */
  action: MeterAction
}

export type MeterLevel = 'idle' | 'ok' | 'warn' | 'breach'

/**
 * `resume-blocked` is a paused ravel already at its ceiling: resuming it would
 * re-pause at the next budget gate, so the ceiling has to be raised first.
 */
export type MeterAction = 'none' | 'pause' | 'resume' | 'resume-blocked'

/** Amber from here. Late enough to mean something, early enough to act on. */
const WARN_AT = 0.75

/**
 * Ranking for the single ring, lower is more urgent.
 *
 * Spend alone is the wrong rule: a finished 200k ravel would permanently outrank a
 * running one at 49k of a 50k ceiling, so the ring would show history while the
 * ravel about to breach stayed invisible. Only a ravel that can still spend is
 * worth the ring; terminal ones are ranked last and expose no stop control.
 */
const URGENCY: Record<PublicRavelConfig['status'], number> = {
  running: 0,
  'awaiting-approval': 1,
  paused: 2,
  idle: 3,
  error: 4,
  completed: 5
}

/** Statuses where children may still be burning tokens, so Pause means something. */
const STOPPABLE: Record<PublicRavelConfig['status'], true | undefined> = {
  running: true,
  'awaiting-approval': true,
  idle: undefined,
  paused: undefined,
  error: undefined,
  completed: undefined
}

/** A session in this state still owns a pty; `error` and `closed` do not. */
const HOLDS_PTY: Record<Session['status'], true | undefined> = {
  starting: true,
  running: true,
  'needs-input': true,
  closed: undefined,
  error: undefined
}

export function ravelSpend(ravel: PublicRavelConfig): number {
  return ravel.usage.inputTokens + ravel.usage.outputTokens
}

/**
 * Picks the ravel the ring tracks: most urgent status first, then highest spend,
 * then most recent. See URGENCY for why status leads.
 */
export function selectFleetMeter(
  ravels: readonly PublicRavelConfig[],
  sessions: readonly Session[],
  tokenCeilingPerRavel: number
): FleetMeter {
  const liveSessionCount = sessions.filter((s) => HOLDS_PTY[s.status]).length

  let focus: PublicRavelConfig | null = null
  let spent = 0
  for (const ravel of ravels) {
    if (focus === null) {
      focus = ravel
      spent = ravelSpend(ravel)
      continue
    }
    const candidate = ravelSpend(ravel)
    const rank = URGENCY[ravel.status] - URGENCY[focus.status]
    const better =
      rank !== 0 ? rank < 0 : candidate !== spent ? candidate > spent : ravel.createdAt > focus.createdAt
    if (better) {
      focus = ravel
      spent = candidate
    }
  }

  if (focus === null) {
    return {
      ravel: null,
      spent: 0,
      ratio: null,
      costUsd: null,
      ravelCount: 0,
      liveSessionCount,
      level: 'idle',
      action: 'none'
    }
  }

  const ceiling = tokenCeilingPerRavel > 0 ? tokenCeilingPerRavel : 0
  const ratio = ceiling > 0 ? spent / ceiling : null
  const atCeiling = ratio !== null && ratio >= 1
  return {
    ravel: focus,
    spent,
    ratio: ratio === null ? null : Math.min(1, ratio),
    costUsd: focus.usage.costUsd,
    ravelCount: ravels.length,
    liveSessionCount,
    level: atCeiling ? 'breach' : ratio !== null && ratio >= WARN_AT ? 'warn' : 'ok',
    action:
      focus.status === 'paused'
        ? atCeiling
          ? 'resume-blocked'
          : 'resume'
        : STOPPABLE[focus.status]
          ? 'pause'
          : 'none'
  }
}

/**
 * `12400` -> `12.4k`, `50000` -> `50k`. Ceilings are set in tens of thousands, so
 * raw digits do not read; a trailing `.0` is noise on a preset chip.
 *
 * Rounding is applied before the unit is chosen, so 999,500 reads `1M` rather than
 * rolling over to a `1000k` that never appears at any other input.
 */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  const k = n / 1000
  if (Math.round(k) < 1000) {
    return `${k < 100 ? k.toFixed(1).replace(/\.0$/, '') : Math.round(k)}k`
  }
  const m = n / 1_000_000
  return `${m < 100 ? m.toFixed(1).replace(/\.0$/, '') : Math.round(m)}M`
}

/**
 * Cost is never hidden and never rounds to a free-looking `$0.00`: an unpriced
 * model reports that it is unpriced, and a real sub-cent charge says so.
 */
export function formatCost(costUsd: number | null): string {
  if (costUsd === null) return 'cost unknown'
  if (costUsd === 0) return '~$0.00'
  return costUsd < 0.01 ? '<$0.01' : `~$${costUsd.toFixed(2)}`
}
