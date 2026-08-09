// The single source of the session/ravel/roundtable "state" vocabulary used by
// the Sessions rail cards and the bottom dock chips. Pure and unit-tested so the
// state → colour/animation mapping cannot drift between the two surfaces.
import type { PublicRavelConfig, RoundtableConfig, Session } from '@shared/types'

export type ActivityState = 'working' | 'idle' | 'needs-input' | 'complete' | 'error'

export interface ActivityMeta {
  label: string
  /** Tailwind background class for the status dot. */
  dotClass: string
  /** Whether the dot animates (the agent is actively doing or awaiting something). */
  pulse: boolean
}

export const ACTIVITY_META: Record<ActivityState, ActivityMeta> = {
  working: { label: 'Working', dotClass: 'bg-accent', pulse: true },
  idle: { label: 'Idle', dotClass: 'bg-text-hint', pulse: false },
  'needs-input': { label: 'Held up', dotClass: 'bg-amber-400', pulse: true },
  complete: { label: 'Complete', dotClass: 'bg-green-400', pulse: false },
  error: { label: 'Error', dotClass: 'bg-red-400', pulse: false }
}

export function activityStateOfSession(session: Session): ActivityState {
  switch (session.status) {
    case 'starting':
    case 'running':
      return 'working'
    case 'needs-input':
      return 'needs-input'
    case 'closed':
      return 'complete'
    case 'error':
      return 'error'
  }
}

export function activityStateOfRavel(cfg: PublicRavelConfig): ActivityState {
  if (cfg.status === 'error') return 'error'
  if (cfg.status === 'completed') return 'complete'
  if (cfg.status === 'awaiting-approval' || cfg.activity === 'needs-clarification') return 'needs-input'
  if (cfg.activity === 'thinking' || cfg.status === 'running') return 'working'
  return 'idle'
}

export function activityStateOfRoundtable(cfg: RoundtableConfig): ActivityState {
  switch (cfg.status) {
    case 'running':
      return 'working'
    case 'concluded':
      return 'complete'
    case 'error':
      return 'error'
    case 'paused':
    case 'idle':
      return 'idle'
  }
}
