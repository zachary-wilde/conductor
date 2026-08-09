import { ACTIVITY_META, type ActivityState } from '../lib/activityState'

/**
 * The animated state indicator shared by session cards and dock chips: a dot
 * that pulses while the agent is working or awaiting input, plus an optional
 * label. Sourced from `ACTIVITY_META` so the two surfaces never diverge.
 */
export function ActivityBadge({
  state,
  label = false
}: {
  state: ActivityState
  label?: boolean
}): JSX.Element {
  const meta = ACTIVITY_META[state]
  return (
    <span className="inline-flex items-center gap-1.5" data-testid={`activity-${state}`}>
      <span className="relative grid h-2 w-2 place-items-center">
        {meta.pulse && (
          <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${meta.dotClass}`} />
        )}
        <span className={`relative inline-flex h-2 w-2 rounded-full ${meta.dotClass}`} />
      </span>
      {label && <span className="text-[11px] text-text-low">{meta.label}</span>}
    </span>
  )
}
