// Transient, non-fatal rate-limit banner. When the core answers `429` the
// timeline controller reports the `Retry-After`; this banner surfaces it as a
// thin "Rate limited — retrying in Ns" strip under the TopBar with a live
// countdown, then hides itself when the backoff window elapses. It never blocks
// interaction and never wipes the timeline — the operator can keep reading.

import { useEffect, useState } from 'react'
import { useTimeline } from '../state/timeline'

export function RateLimitBanner(): JSX.Element | null {
  const { rateLimit, clearRateLimit } = useTimeline()
  const [, setTick] = useState(0)

  // Re-render a few times a second for the countdown, and clear the signal once
  // the core's backoff window has elapsed. The interval closes over the current
  // `rateLimit`; setting it null tears the effect down.
  useEffect(() => {
    if (!rateLimit) return
    const id = setInterval(() => {
      setTick((n) => n + 1)
      if (Date.now() >= rateLimit.expiresAt) clearRateLimit()
    }, 250)
    return (): void => clearInterval(id)
  }, [rateLimit, clearRateLimit])

  if (!rateLimit) return null
  const remaining = Math.max(0, Math.ceil((rateLimit.expiresAt - Date.now()) / 1000))
  return (
    <div className="flex items-center gap-2 border-b border-[rgb(var(--warn))]/30 bg-[rgb(var(--warn))]/10 px-4 py-2 md:px-6">
      <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[rgb(var(--warn))]" />
      <span className="font-mono text-[11px] text-[rgb(var(--warn))]">
        Rate limited — retrying in {remaining}s
      </span>
    </div>
  )
}
