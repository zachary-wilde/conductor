// Workers screen — the fleet roster, derived purely from the folded timeline.
// Each row is a worker the client has seen; tapping opens the detail pane where
// controls are issued. Re-derives on every timeline update so the roster is live.

import { useEffect, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { useTimeline } from '../state/timeline'
import { deriveWorkers } from '../viewmodel/workers'
import { formatRelative, kindMeta, toneChip } from '../viewmodel/events'
import { Badge, EmptyState } from '../components/ui'
import type { Route } from '../state/router'

export function WorkersView({ navigate }: { navigate: (r: Route) => void }): JSX.Element {
  const { state } = useTimeline()
  const workers = deriveWorkers(state.events)

  // Tick every 15s so relative timestamps stay fresh without re-rendering on
  // every inbound event.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 15_000)
    return () => window.clearInterval(t)
  }, [])

  if (workers.length === 0) {
    return (
      <EmptyState
        title="No workers seen yet"
        body="Workers appear here as soon as the timeline records an event carrying a worker or session id."
      />
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {workers.map((w) => {
        const meta = kindMeta(w.latestKind)
        return (
          <button
            key={w.key}
            onClick={() => navigate({ name: 'worker', workerId: w.workerId })}
            className="group flex items-start gap-3 rounded-lg border border-edge bg-bg-1 p-3 text-left transition-colors hover:border-accent/40 hover:bg-bg-2"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate font-mono text-xs text-text-hi">{w.workerId}</span>
                {w.harness ? (
                  <span className="rounded bg-bg-3 px-1.5 py-0.5 font-mono text-[10px] text-text-mid">
                    {w.harness}
                  </span>
                ) : null}
                {w.role ? (
                  <span className="font-mono text-[10px] text-text-low">{w.role}</span>
                ) : null}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-text-hint">
                {w.workerKind ? <span>{w.workerKind}</span> : null}
                {w.repoId ? <span>· {w.repoId}</span> : null}
                <span>· {w.eventCount} event{w.eventCount === 1 ? '' : 's'}</span>
                <span>· {formatRelative(w.lastSeen, now)} ago</span>
              </div>
              <p className="mt-1 line-clamp-1 text-xs text-text-mid">{w.latestSummary}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Badge className={toneChip(meta.tone)}>{meta.label}</Badge>
              <ChevronRight size={16} className="text-text-hint transition-colors group-hover:text-accent" />
            </div>
          </button>
        )
      })}
    </div>
  )
}
