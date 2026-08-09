import { X } from 'lucide-react'
import type { CanvasPanel, HarnessId, Session, PublicRavelConfig, RoundtableConfig } from '@shared/types'
import { BEHAVIOR_LABELS } from '@shared/types'
import { AgentIcon } from './AgentIcon'
import { ActivityBadge } from './ActivityBadge'
import {
  activityStateOfSession,
  activityStateOfRavel,
  activityStateOfRoundtable,
  type ActivityState
} from '../lib/activityState'

/**
 * The bottom dock strip for minimized windows. Each chip shows the panel's
 * icon, a short label, and an animated state badge. Clicking restores the
 * panel to its prior geometry; the close control dismisses it entirely.
 *
 * Rendered only when at least one panel is minimized.
 */
export function Dock({
  panels,
  sessions,
  ravels,
  roundtables,
  onRestore,
  onClose
}: {
  panels: CanvasPanel[]
  sessions: Session[]
  ravels: PublicRavelConfig[]
  roundtables: RoundtableConfig[]
  onRestore: (id: string) => void
  onClose: (id: string) => void
}): JSX.Element | null {
  if (panels.length === 0) return null

  return (
    <div
      data-testid="dock"
      className="glass-panel absolute bottom-0 left-0 right-0 z-50 flex items-center gap-2 border-t px-3 py-2"
    >
      {panels.map((panel) => (
        <DockChip
          key={panel.id}
          panel={panel}
          sessions={sessions}
          ravels={ravels}
          roundtables={roundtables}
          onRestore={() => onRestore(panel.id)}
          onClose={() => onClose(panel.id)}
        />
      ))}
    </div>
  )
}

function DockChip({
  panel,
  sessions,
  ravels,
  roundtables,
  onRestore,
  onClose
}: {
  panel: CanvasPanel
  sessions: Session[]
  ravels: PublicRavelConfig[]
  roundtables: RoundtableConfig[]
  onRestore: () => void
  onClose: () => void
}): JSX.Element {
  const { harness, label, activityState } = useDockChipContent(panel, sessions, ravels, roundtables)

  return (
    <div
      data-testid="dock-chip"
      data-panel-id={panel.id}
      onClick={onRestore}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onRestore()
        }
      }}
      role="button"
      tabIndex={0}
      className="glass-panel flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 hover:bg-white/[0.08]"
    >
      <AgentIcon harness={harness} size={14} />
      <span className="text-[11px] font-medium text-text-hi">{label}</span>
      {activityState && <ActivityBadge state={activityState} />}
      <button
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        onMouseDown={(e) => e.stopPropagation()}
        aria-label={`Close ${label}`}
        className="ml-1 grid h-[16px] w-[16px] place-items-center rounded-[4px] text-text-low hover:bg-red-500/25 hover:text-text-hi"
      >
        <X size={10} />
      </button>
    </div>
  )
}

function useDockChipContent(
  panel: CanvasPanel,
  sessions: Session[],
  ravels: PublicRavelConfig[],
  roundtables: RoundtableConfig[]
): {
  harness: HarnessId | null
  label: string
  activityState: ActivityState | null
} {
  switch (panel.kind) {
    case 'session': {
      const session = sessions.find((s) => s.id === panel.subjectId)
      if (!session) return { harness: null, label: 'Session', activityState: null }
      
      const roleLabel = session.kind === 'ravel-child' && session.ravelRole !== null
        ? BEHAVIOR_LABELS[session.ravelRole]
        : null
      
      return {
        harness: session.harness,
        label: roleLabel ? `${session.harness ?? 'terminal'} · ${roleLabel}` : (session.harness ?? 'Terminal'),
        activityState: activityStateOfSession(session)
      }
    }
    case 'ravel': {
      const ravel = ravels.find((r) => r.id === panel.subjectId)
      if (!ravel) return { harness: null, label: 'Ravel', activityState: null }
      return {
        harness: ravel.harness,
        label: ravel.name,
        activityState: activityStateOfRavel(ravel)
      }
    }
    case 'roundtable': {
      const roundtable = roundtables.find((rt) => rt.id === panel.subjectId)
      if (!roundtable) return { harness: null, label: 'Roundtable', activityState: null }
      // Roundtables don't have a single harness; use null for a generic icon
      return {
        harness: null,
        label: roundtable.name,
        activityState: activityStateOfRoundtable(roundtable)
      }
    }
    case 'sessions':
      return { harness: null, label: 'Sessions', activityState: null }
    case 'work':
      return { harness: null, label: 'Work', activityState: null }
    case 'fleet':
      return { harness: null, label: 'Fleet', activityState: null }
    case 'settings':
      return { harness: null, label: 'Settings', activityState: null }
  }
}
