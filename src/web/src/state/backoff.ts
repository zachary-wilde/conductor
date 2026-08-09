// Exponential backoff schedule for reconnecting a flaky timeline stream.
//
// A phone driving a PC core over wifi will drop the SSE connection whenever
// the network blips. Rather than die (or let the browser hammer the core), the
// timeline controller closes the dead EventSource and reopens it after a delay
// computed here. The schedule climbs 1s → 2s → 5s then caps at 10s, with a
// small ±jitter so a fleet of reconnecting clients cannot thunder-herd the
// core. Pure and deterministic given an injectable `random` — tests pass a
// constant so the exact delay is assertable.

/** Base delay (ms) for each reconnect attempt before the cap kicks in. */
export const BACKOFF_SCHEDULE_MS = [1000, 2000, 5000] as const
/** Maximum backoff delay (ms); attempts beyond the schedule stay here. */
export const BACKOFF_CAP_MS = 10_000
/** Half-range of the jitter band, as a fraction of the base delay. */
const BACKOFF_JITTER = 0.1

/** A [0, 1) source of randomness; `Math.random` in production, a stub in tests. */
export type Random = () => number

/**
 * Delay (ms) before the `attempt`-th reconnect (0 = first retry). Climbs the
 * schedule then caps; ±10% jitter keeps reconnects desynchronised. Never
 * negative, never above the cap + jitter.
 *
 * @param attempt how many reconnects have already happened (0-based)
 * @param random  injectable randomness; defaults to `Math.random`
 */
export function backoffDelay(attempt: number, random: Random = Math.random): number {
  const a = Math.max(0, Math.floor(attempt))
  const base = a < BACKOFF_SCHEDULE_MS.length ? BACKOFF_SCHEDULE_MS[a] : BACKOFF_CAP_MS
  const jitter = base * BACKOFF_JITTER * (random() * 2 - 1)
  return Math.max(0, Math.round(base + jitter))
}
