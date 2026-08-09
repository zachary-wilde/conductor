// One row of the live timeline. Presentational: takes a normalized event and
// renders its time, kind chip, worker attribution, and summary. The dense,
// scannable layout is the whole point of the home screen.

import type { NormalizedEvent } from '@ops/events'
import { formatClock, kindMeta, toneChip } from '../viewmodel/events'
import { Badge } from './ui'

export function EventRow({ ev }: { ev: NormalizedEvent }): JSX.Element {
  const meta = kindMeta(ev.kind)
  return (
    <div className="flex items-start gap-2.5 px-4 py-2 transition-colors hover:bg-bg-1/60">
      <span className="mt-0.5 w-16 shrink-0 font-mono text-[10px] text-text-hint">
        {formatClock(ev.timestamp)}
      </span>
      <Badge className={`shrink-0 ${toneChip(meta.tone)}`}>{meta.label}</Badge>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] text-text-low">
          {ev.workerKind ? <span className="text-text-mid">{ev.workerKind}</span> : null}
          {ev.role ? <span>· {ev.role}</span> : null}
          {ev.harness ? <span>· {ev.harness}</span> : null}
          {ev.attempt > 1 ? <span className="text-text-hint">· try {ev.attempt}</span> : null}
        </div>
        <p className="selectable line-clamp-2 text-xs leading-relaxed text-text-mid">
          {ev.summary}
        </p>
      </div>
    </div>
  )
}
