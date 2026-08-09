import type { PublicRavelConfig, RavelDispatchRecord, Session, SessionBehavior } from '@shared/types'
import { agentInfo, BEHAVIOR_LABELS } from '@shared/types'
import { GitBranch, X } from 'lucide-react'
import { useStore } from '../store/useStore'
import { activityStateOfSession } from '../lib/activityState'
import { formatCost, formatTokens } from '../lib/fleetMeter'
import { useDocumentWorkspace } from './DocumentWorkspace'
import { AgentIcon } from './AgentIcon'
import { ActivityBadge } from './ActivityBadge'

interface SessionCardProps {
  session: Session
  selected?: boolean
  compact?: boolean
  testId?: string
  dataSessionRow?: boolean
  tabIndex?: number
  onFocus?: () => void
  onOpen?: () => void
}

interface SessionCardDetails {
  model: string
  identity: string
  dispatch: RavelDispatchRecord | null
}

function sessionDetails(session: Session, ravels: readonly PublicRavelConfig[]): SessionCardDetails {
  const info = agentInfo(session.harness)
  const sessionData = session as Session & {
    behavior?: SessionBehavior | null
    model?: string | null
    role?: SessionBehavior | null
  }
  const sessionModel = sessionData.model?.trim()
  const ravel = session.ravelId === null ? null : ravels.find((item) => item.id === session.ravelId) ?? null
  const brief = ravel?.plan?.briefs.find((item) => item.id === session.briefId) ?? null
  const dispatch =
    ravel?.dispatches.find((item) => item.sessionId === session.id || item.briefId === session.briefId) ?? null
  const model = sessionModel || brief?.model?.trim() || info.label
  const roleValue = session.ravelRole ?? sessionData.role ?? sessionData.behavior ?? null
  const role = roleValue === null ? null : BEHAVIOR_LABELS[roleValue]

  return {
    model,
    identity: role === null ? model : `${model} · ${role}`,
    dispatch
  }
}

function contextRatio(session: Session, dispatch: RavelDispatchRecord | null, tokens: number): number | null {
  const sessionData = session as Session & { contextWindowTokens?: number | null }
  const dispatchData = dispatch as (RavelDispatchRecord & { contextWindowTokens?: number | null }) | null
  const limit = sessionData.contextWindowTokens ?? dispatchData?.contextWindowTokens ?? null
  if (!Number.isFinite(limit) || limit === null || limit <= 0) return null
  return Math.min(1, Math.max(0, tokens / limit))
}


export function SessionCard({
  session,
  selected,
  compact = false,
  testId = 'session-card',
  dataSessionRow = false,
  tabIndex,
  onFocus,
  onOpen
}: SessionCardProps): JSX.Element {
  const openSession = useStore((s) => s.openSession)
  const selectedSessionId = useStore((s) => s.selectedSessionId)
  const view = useStore((s) => s.view)
  const ravels = useStore((s) => s.ravelList)
  const { requestSessionDismissal } = useDocumentWorkspace()
  const details = sessionDetails(session, ravels)
  const usage = details.dispatch?.usage ?? null
  const tokens = usage === null ? null : usage.inputTokens + usage.outputTokens
  const ratio = tokens === null ? null : contextRatio(session, details.dispatch, tokens)
  const isSelected = selected ?? (view === 'session' && selectedSessionId === session.id)
  const open = onOpen ?? (() => openSession(session.id))

  return (
    <button
      type="button"
      data-testid={testId}
      data-session-row={dataSessionRow ? true : undefined}
      tabIndex={tabIndex}
      aria-current={isSelected ? 'page' : undefined}
      aria-label={details.identity}
      onClick={open}
      onFocus={onFocus}
      className={`glass-panel group relative flex w-full flex-col text-left transition-colors hover:border-accent/40 hover:bg-[var(--glass-hover)] ${
        compact ? 'gap-2.5 p-2.5' : 'gap-3 p-4'
      } ${isSelected ? 'border-accent/60 bg-accent/[0.13] shadow-[inset_2px_0_0_rgb(var(--accent)/0.8)]' : 'border-white/[0.07]'}`}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <AgentIcon harness={session.harness} size={compact ? 14 : 16} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-text-hi">{details.identity}</div>
          <div className="mt-1 flex items-center gap-1.5">
            <ActivityBadge state={activityStateOfSession(session)} label />
          </div>
        </div>
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] text-text-low">
        <span className="inline-flex min-w-0 items-center gap-1" title={`Branch ${session.branch}`}>
          <GitBranch size={10} className="shrink-0 text-text-hint" />
          <span className="truncate">{session.branch}</span>
        </span>
        <span className="truncate" title={`Model ${details.model}`}>
          {details.model}
        </span>
        {usage !== null && tokens !== null && (
          <>
            <span>{formatTokens(tokens)} tok est.</span>
            <span>{formatCost(usage.costUsd)}</span>
          </>
        )}
      </div>

      {ratio !== null && tokens !== null && (
        <div
          className="h-1 overflow-hidden rounded-full bg-white/[0.09]"
          role="progressbar"
          aria-label="Context usage"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(ratio * 100)}
        >
          <span
            className="block h-full rounded-full bg-accent/75 transition-[width]"
            style={{ width: `${ratio * 100}%` }}
          />
        </div>
      )}

      {session.status === 'closed' && (
        <span
          role="button"
          tabIndex={0}
          onClick={(event) => {
            event.stopPropagation()
            const trigger = event.currentTarget
            void requestSessionDismissal(session.id).then((dismissed) => {
              if (!dismissed && trigger.isConnected) trigger.focus()
            })
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            event.stopPropagation()
            event.currentTarget.click()
          }}
          title="Dismiss"
          aria-label="Dismiss session"
          className="absolute right-2 top-2 text-text-low hover:text-text-hi"
        >
          <X size={13} />
        </span>
      )}
    </button>
  )
}
