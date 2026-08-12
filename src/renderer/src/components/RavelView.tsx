import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useStore } from '../store/useStore'
import { HarnessBadge } from './HarnessBadge'
import { STATUS_META, timeAgo } from '../lib/ui'
import {
  canApprovePlanInView,
  childRavelRoleLabel,
  fleetActivity,
  ravelActivityLabel,
  ravelStatusLabel,
  type FleetActivityEntry
} from '../lib/ravelViewModel'
import {
  clipPaths,
  mergeFailureSummary,
  mergeReviewRows,
  overlapSummary,
  reviewRowState,
  landedSummary,
  type LandedRecord,
  type MergeReviewRow
} from '../lib/mergeViewModel'
import { ResizeHandle } from './ResizeHandle'
import {
  panelVisible,
  panelWidth,
  orderPanels,
  composeModel,
  harnessSupportsBehavior,
  splitModel,
  HARNESS_INFO,
  agentInfo,
  modelOptionsFor,
  THINKING_LEVELS,
  PANEL_IDS,
  panelDock,
  RAIL_PANEL_IDS,
  type ChildRavelRole,
  type DispatchVerification,
  type HarnessCatalogue,
  type HarnessId,
  type PanelId,
  type PublicRavelConfig,
  type RailPanelId,
  type RavelBrief,
  type PanelDock,
  type Settings,
  type MergePreviewResult,
  type RavelDispatchRecord,
  type RavelLogLevel,
  type RavelMessage,
  type Session,
  type SessionActivityEntry,
  type ThinkingLevel
} from '@shared/types'
import { defaultModelForRole } from '@shared/pricing'
import {
  Activity,
  TerminalSquare,
  AlertTriangle,
  ArrowLeft,
  ClipboardList,
  CornerDownLeft,
  GitBranch,
  GitMerge,
  Loader2,
  Monitor,
  Pause,
  Play,
  RefreshCw,
  ScrollText,
  Send,
  ShieldCheck,
  Sparkles,
  Trash2,
  Users
} from 'lucide-react'

const MAX_MESSAGE_CHARS = 16000
const CHILD_ROLES: ChildRavelRole[] = [
  'lead-engineer',
  'auditor',
  'minor-task',
  'researcher',
  'test-engineer',
  'security-engineer',
  'performance-engineer',
  'release-engineer'
]
const LOG_COLOR: Record<RavelLogLevel, string> = {
  info: '#6b6b76',
  action: '#34c759',
  warn: '#ff9500',
  error: '#ef4444'
}
const RAVEL_STATUS_COLOR: Record<PublicRavelConfig['status'], string> = {
  idle: '#6b6b76',
  'awaiting-approval': '#ff9500',
  running: '#34c759',
  paused: '#6b6b76',
  completed: '#32d4de',
  error: '#ef4444'
}

/**
 * The conversation never goes under this. Two rails at their default widths do
 * not fit beside it on a 1440px window, so one of the three has to yield — and
 * it must not be the transcript, which is the content.
 */
const CONVERSATION_MIN_PX = 380

type RavelTab = RailPanelId

const RAIL_TAB_META: Record<RavelTab, { label: string; icon: ReactNode }> = {
  activity: { label: 'Activity', icon: <Activity size={13} /> },
  plan: { label: 'Plan', icon: <ClipboardList size={13} /> },
  fleet: { label: 'Fleet', icon: <Users size={13} /> },
  log: { label: 'Log', icon: <ScrollText size={13} /> },
  manager: { label: 'Manager', icon: <Monitor size={13} /> }
}

/**
 * `ravelId` is the panel's own subject. Two ravel panels can be open at once, so
 * the view can no longer read one global selection; the store value remains the
 * fallback for callers that have no panel of their own.
 */
export function RavelView({ ravelId }: { ravelId?: string } = {}): JSX.Element {
  const ravelList = useStore((s) => s.ravelList)
  const storeSelected = useStore((s) => s.selectedRavelId)
  const selectedId = ravelId ?? storeSelected
  const sessions = useStore((s) => s.sessions)
  const logs = useStore((s) => s.ravelLogs)
  const harnesses = useStore((s) => s.harnesses)
  const busy = useStore((s) => s.busy)
  const panels = useStore((s) => s.settings.panels)
  const settings = useStore((s) => s.settings)
  const activity = useStore((s) => s.activity)
  const panelSizes = useStore((s) => s.settings.panelSizes)
  const saveSettings = useStore((s) => s.saveSettings)
  const [railDraft, setRailDraft] = useState<number | null>(null)
  const [leftRailDraft, setLeftRailDraft] = useState<number | null>(null)
  const [dragTab, setDragTab] = useState<RavelTab | null>(null)
  const [dropTab, setDropTab] = useState<RavelTab | null>(null)
  const [dropDock, setDropDock] = useState<PanelDock | null>(null)
  const back = useStore((s) => s.back)
  const openSession = useStore((s) => s.openSession)
  const sendMessage = useStore((s) => s.sendRavelMessage)
  const approvePlan = useStore((s) => s.approveRavelPlan)
  const requestChanges = useStore((s) => s.requestRavelPlanChanges)
  const assignBrief = useStore((s) => s.updateRavelBriefAssignment)
  const pauseRavel = useStore((s) => s.pauseRavel)
  const resumeRavel = useStore((s) => s.resumeRavel)
  const resumeInterruptedBrief = useStore((s) => s.resumeInterruptedRavelBrief)
  const claimBrief = useStore((s) => s.claimBrief)
  const deleteRavel = useStore((s) => s.deleteRavel)
  const modelCatalogues = useStore((s) => s.modelCatalogues)

  const steerChild = useStore((s) => s.steerRavelChild)
  const cfg = ravelList.find((ravel) => ravel.id === selectedId)
  const [tab, setTab] = useState<RavelTab>('activity')
  const [leftTab, setLeftTab] = useState<RavelTab>('manager')
  const [composer, setComposer] = useState('')
  const [changeRequest, setChangeRequest] = useState('')
  const [selectedRevision, setSelectedRevision] = useState<number | null>(cfg?.plan?.revision ?? null)
  const transcriptRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const shouldStickToBottom = useRef(true)

  useEffect(() => {
    setSelectedRevision(cfg?.plan?.revision ?? null)
    setChangeRequest('')
  }, [cfg?.id, cfg?.plan?.revision])

  useEffect(() => {
    if (cfg?.activity === 'needs-clarification') composerRef.current?.focus()
  }, [cfg?.activity, cfg?.messages.length])

  const orderedMessages = useMemo(() => {
    return [...(cfg?.messages ?? [])].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  }, [cfg?.messages])

  useEffect(() => {
    const node = transcriptRef.current
    if (!node || !shouldStickToBottom.current) return
    node.scrollTop = node.scrollHeight
  }, [orderedMessages.length, orderedMessages.at(-1)?.delivery, orderedMessages.at(-1)?.body])

  if (!cfg) {
    return <div className="p-6 text-sm text-text-low">No Ravel selected.</div>
  }

  const entries = logs[cfg.id] ?? []
  const railWidth = railDraft ?? panelWidth(panelSizes, 'ravelRail')
  const leftRailWidth = leftRailDraft ?? panelWidth(panelSizes, 'ravelRailLeft')
  const railOrder = orderPanels(RAIL_PANEL_IDS, settings.panelOrder)
  const visibleTabs = railOrder.filter((id) => panelVisible(panels, id))
  const rightTabs = visibleTabs.filter((id) => panelDock(settings.panelDock, id) === 'right')
  const leftTabs = visibleTabs.filter((id) => panelDock(settings.panelDock, id) === 'left')
  const childSessions = sessions.filter(isRavelChildFor(cfg.id))
  const availableHarnesses = harnesses.filter((harness) => harness.available)
  const canApprove = canApprovePlanInView(cfg.plan, selectedRevision, busy) && cfg.status === 'awaiting-approval'
  const planCurrent = cfg.plan !== null && selectedRevision === cfg.plan.revision
  const planApproved = cfg.plan !== null && cfg.plan.approvedRevision === cfg.plan.revision
  const canMutatePlan = cfg.plan !== null && planCurrent && !busy && !planApproved
  const activityEntries = fleetActivity(activity, sessions, cfg)
  const activeTab = rightTabs.includes(tab) ? tab : (rightTabs[0] ?? null)
  const activeLeftTab = leftTabs.includes(leftTab) ? leftTab : (leftTabs[0] ?? null)
  const statusColor = RAVEL_STATUS_COLOR[cfg.status]
  const statusPulse = cfg.status === 'running' || cfg.activity === 'thinking'
  const spentTokens = cfg.usage.inputTokens + cfg.usage.outputTokens
  const overBudget = settings.tokenCeilingPerRavel > 0 && spentTokens >= settings.tokenCeilingPerRavel
  // Only the newest Ravel message can be the open question; offering the
  // buttons on an older one would answer a question that was already settled.
  const lastQuestionId = orderedMessages.filter((message) => message.author === 'ravel').at(-1)?.id ?? null

  const onTranscriptScroll = (): void => {
    const node = transcriptRef.current
    if (!node) return
    shouldStickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 96
  }

  /**
   * One write for both halves of a move. Re-docking and reordering are a
   * single user gesture — dragging a tab onto the other rail — so splitting
   * them into two saves would let one land without the other.
   *
   * The order rewrite covers the whole panel list, not just the rail's slice:
   * the rail owns five of the ids and must leave the others where they are.
   */
  const moveTab = (from: RavelTab, to: RavelTab | null, zone?: PanelDock): void => {
    const patch: Partial<Settings> = {}
    if (zone !== undefined && panelDock(settings.panelDock, from) !== zone) {
      patch.panelDock = { ...settings.panelDock, [from]: zone }
    }
    const fromIndex = railOrder.indexOf(from)
    const toIndex = to === null ? -1 : railOrder.indexOf(to)
    if (to !== null && fromIndex >= 0 && toIndex >= 0 && fromIndex !== toIndex) {
      const nextRail = [...railOrder]
      nextRail.splice(fromIndex, 1)
      nextRail.splice(toIndex, 0, from)
      let slot = 0
      patch.panelOrder = orderPanels(PANEL_IDS, settings.panelOrder).map((id) =>
        (RAIL_PANEL_IDS as readonly PanelId[]).includes(id) ? nextRail[slot++] : id
      )
    }
    if (patch.panelDock === undefined && patch.panelOrder === undefined) return
    void saveSettings(patch)
  }

  /** Keyboard reorder steps over hidden tabs and stays within one rail. */
  const nudgeTab = (tab: RavelTab, delta: number): void => {
    const within = panelDock(settings.panelDock, tab) === 'left' ? leftTabs : rightTabs
    const target = within[within.indexOf(tab) + delta]
    if (target) moveTab(tab, target)
  }

  const panelBody = (id: RavelTab): JSX.Element => {
    if (id === 'activity') return <ActivityTab entries={activityEntries} />
    if (id === 'plan') {
      return (
        <PlanTab
          cfg={cfg}
          selectedRevision={selectedRevision}
          setSelectedRevision={setSelectedRevision}
          availableHarnesses={availableHarnesses.map((item) => item.id)}
          modelCatalogues={modelCatalogues}
          busy={busy}
          canApprove={canApprove}
          canMutatePlan={canMutatePlan}
          planCurrent={planCurrent}
          planApproved={!!planApproved}
          changeRequest={changeRequest}
          setChangeRequest={setChangeRequest}
          onApprove={() => (cfg.plan ? approvePlan(cfg.id, cfg.plan.revision) : undefined)}
          onRequestChanges={submitChangeRequest}
          onAssignBrief={(briefId, assignment) =>
            cfg.plan ? assignBrief(cfg.id, cfg.plan.revision, briefId, assignment) : undefined
          }
          onClaimBrief={(briefId) => {
            if (cfg.plan) void claimBrief(cfg.id, cfg.plan.revision, briefId)
          }}
        />
      )
    }
    if (id === 'fleet') {
      return (
        <FleetTab
          cfg={cfg}
          childSessions={childSessions}
          sessions={sessions}
          busy={busy}
          onOpenSession={openSession}
          onResumeInterrupted={(record) => resumeInterruptedBrief(cfg.id, record.planRevision, record.briefId)}
          onSteer={(sessionId, note) => steerChild(cfg.id, sessionId, note)}
        />
      )
    }
    if (id === 'log') return <LogTab entries={entries} />
    return <ManagerTab entries={entries} />
  }

  /**
   * Both rails are the same surface, so they are built from one expression.
   * A panel is wherever the operator dropped it; the rail it lands in is the
   * only thing that differs.
   */
  const rail = (
    zone: PanelDock,
    tabs: RavelTab[],
    active: RavelTab | null,
    onSelect: (next: RavelTab) => void
  ): JSX.Element => (
    <aside
      className={`flex min-w-0 flex-col overflow-hidden ${
        zone === 'left' ? 'glass-divider border-r' : 'glass-divider border-l'
      } ${dragTab !== null && dropDock === zone ? 'ring-1 ring-inset ring-accent/70' : ''}`}
      // Width comes from the grid track, not from here: the parent resolves
      // "this wide unless the conversation would go under its floor".
      aria-label={zone === 'left' ? 'Ravel details, left rail' : 'Ravel details, right rail'}
      onDragOver={(event) => {
        if (dragTab === null) return
        event.preventDefault()
        setDropDock(zone)
      }}
      onDrop={(event) => {
        if (dragTab === null) return
        event.preventDefault()
        moveTab(dragTab, null, zone)
        setDragTab(null)
        setDropTab(null)
        setDropDock(null)
      }}
    >
      <div
        className="glass-divider grid border-b"
        style={{ gridTemplateColumns: `repeat(${Math.max(tabs.length, 1)}, minmax(0, 1fr))` }}
        role="group"
        aria-label={zone === 'left' ? 'Left rail tabs' : 'Right rail tabs'}
      >
        {tabs.map((id) => (
          <RailTab
            key={id}
            tab={id}
            active={active}
            onSelect={onSelect}
            icon={RAIL_TAB_META[id].icon}
            label={RAIL_TAB_META[id].label}
            count={id === 'log' ? entries.length : undefined}
            dragging={dragTab === id}
            dropTarget={dragTab !== null && dragTab !== id && dropTab === id}
            onDragStart={() => setDragTab(id)}
            onDragEnter={() => setDropTab(id)}
            onDrop={() => {
              if (dragTab) moveTab(dragTab, id, zone)
            }}
            onDragEnd={() => {
              setDragTab(null)
              setDropTab(null)
              setDropDock(null)
            }}
            onNudge={(delta) => nudgeTab(id, delta)}
            onDock={() => moveTab(id, null, zone === 'left' ? 'right' : 'left')}
          />
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">{active !== null && panelBody(active)}</div>
    </aside>
  )

  /** Only while a drag is in flight: an empty rail is otherwise wasted width. */
  const emptyDock = (zone: PanelDock): JSX.Element => (
    <div
      className={`glass-divider flex w-10 shrink-0 items-center justify-center text-[9px] uppercase tracking-widest text-text-hint ${
        zone === 'left' ? 'border-r' : 'border-l'
      } ${dropDock === zone ? 'bg-accent/15 text-accent' : 'bg-[var(--glass-inset-bg)]'}`}
      onDragOver={(event) => {
        event.preventDefault()
        setDropDock(zone)
      }}
      onDrop={(event) => {
        event.preventDefault()
        if (dragTab) moveTab(dragTab, null, zone)
        setDragTab(null)
        setDropTab(null)
        setDropDock(null)
      }}
    >
      <span className="-rotate-90 whitespace-nowrap">dock {zone}</span>
    </div>
  )

  const submitMessage = async (): Promise<void> => {
    const body = composer.trim()
    if (!body || busy) return
    const result = await sendMessage(cfg.id, body)
    if (result) setComposer('')
  }

  const retryMessage = async (message: RavelMessage): Promise<void> => {
    if (busy || message.body.trim().length === 0) return
    await sendMessage(cfg.id, message.body)
  }

  const submitChangeRequest = async (): Promise<void> => {
    if (!cfg.plan || !changeRequest.trim() || !planCurrent || busy) return
    const result = await requestChanges(cfg.id, cfg.plan.revision, changeRequest.trim())
    if (result) setChangeRequest('')
  }

  const onDelete = async (): Promise<void> => {
    if (
      confirm(
        `Delete Ravel "${cfg.name}"?\n\nThis closes the Orchestrator and all Ravel child sessions for this fleet.`
      )
    ) {
      await deleteRavel(cfg.id)
      back()
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="glass-bar flex shrink-0 items-center gap-3 border-b px-4 py-2.5">
        <button className="btn-ghost px-2" onClick={back} data-testid="back" title="Back" aria-label="Back">
          <ArrowLeft size={16} />
        </button>
        <div className="relative flex h-7 w-7 items-center justify-center rounded-md border border-accent/25 bg-accent/10 text-accent">
          <span className="absolute -left-6 top-1/2 h-px w-6 bg-gradient-to-r from-transparent to-accent/60" />
          <Sparkles size={15} />
          <span className="absolute -right-6 top-1/2 h-px w-6 bg-gradient-to-r from-cyan-300/40 to-transparent" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <div className="truncate text-sm font-medium">{cfg.name}</div>
            <StatusPill color={statusColor} pulse={statusPulse}>
              {ravelStatusLabel(cfg.status)} · {ravelActivityLabel(cfg.activity)}
            </StatusPill>
            <StatusPill color={overBudget ? '#fbbf24' : '#32d4de'} pulse={false}>
              ~{spentTokens} tok est.
              {settings.tokenCeilingPerRavel > 0 ? ` / ${settings.tokenCeilingPerRavel}` : ''}
              {cfg.usage.costUsd === null ? '' : ` · ~$${cfg.usage.costUsd.toFixed(2)}`}
            </StatusPill>
          </div>
          <div className="truncate font-mono text-[10px] text-text-hint">
            Manager · {HARNESS_INFO[cfg.harness].label} · {cfg.repoPath}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          {cfg.status === 'paused' ? (
            <button
              className="btn-outline px-2.5"
              onClick={() => resumeRavel(cfg.id)}
              disabled={busy}
              title="Resume hands the manager one turn to pick the plan back up."
            >
              <Play size={14} /> Resume
            </button>
          ) : (
            <button
              className="btn-outline px-2.5"
              onClick={() => pauseRavel(cfg.id)}
              disabled={busy}
              title="Pause cancels the running manager turn and stops new child dispatch."
            >
              <Pause size={14} /> Pause
            </button>
          )}
          <button
            className="btn-ghost px-2 text-text-hint hover:text-red-400"
            onClick={onDelete}
            disabled={busy}
            title="Delete Ravel"
            aria-label="Delete Ravel"
          >
            <Trash2 size={15} />
          </button>
        </div>
      </header>

      {/*
        Grid, not flex. As flex items the rails were `flex-basis` + shrink, so the
        flex algorithm re-shrank them to fit on every render and a drag moved
        nothing — it persisted a new width that was then immediately overridden.

        `minmax(0, Wpx)` gives each rail its set width when there is room and lets
        it yield when there is not, while `minmax(CONVERSATION_MIN, 1fr)` keeps the
        conversation readable. Grid resolves that in one pass; flex cannot express
        "authoritative unless cramped".
      */}
      <div
        className="relative grid min-h-0 flex-1"
        style={{
          gridTemplateColumns: [
            leftTabs.length > 0 ? `minmax(0, ${leftRailWidth}px)` : null,
            `minmax(${CONVERSATION_MIN_PX}px, 1fr)`,
            rightTabs.length > 0 ? `minmax(0, ${railWidth}px)` : null
          ]
            .filter((track) => track !== null)
            .join(' '),
          // The seam CSS centres itself in `--shell-gutter`. Rails here butt
          // straight against the conversation, so the gutter is zero.
          '--shell-gutter': '0px'
        } as React.CSSProperties}
      >
        {leftTabs.length > 0 ? rail('left', leftTabs, activeLeftTab, setLeftTab) : dragTab !== null && emptyDock('left')}
        {leftTabs.length > 0 && (
          <ResizeHandle
            panel="ravelRailLeft"
            edge="right"
            width={leftRailWidth}
            absoluteAt={leftRailWidth}
            onPreview={setLeftRailDraft}
            onCommit={(next) => {
              setLeftRailDraft(next)
              void saveSettings({ panelSizes: { ...panelSizes, ravelRailLeft: next } })
            }}
          />
        )}
        <section className="conversation-surface flex min-w-0 flex-col">
          <div className="glass-divider border-b px-4 py-2 font-mono text-[10px] text-text-hint">
            The manager runs one bounded turn per event — your message, an approval, or a child exiting. Idle costs nothing.
          </div>

          <div
            ref={transcriptRef}
            onScroll={onTranscriptScroll}
            className="selectable relative min-h-0 flex-1 overflow-y-auto px-4 py-4"
            aria-label="Ravel conversation"
          >
            {orderedMessages.length === 0 ? (
              <div className="flex h-full items-center justify-center">
                <div className="glass-panel max-w-md border-dashed px-5 py-6 text-center">
                  <Sparkles size={24} className="mx-auto mb-3 text-accent" />
                  <div className="text-sm text-text-mid">Start with a plain-language instruction.</div>
                  <div className="mt-1 font-mono text-[11px] text-text-hint">
                    Ravel will compile a plan for approval before launching children.
                  </div>
                </div>
              </div>
            ) : (
              <div className="mx-auto flex max-w-3xl flex-col gap-3">
                {orderedMessages.map((message) => (
                  <MessageBubble
                    key={message.id}
                    message={message}
                    busy={busy}
                    onRetry={() => retryMessage(message)}
                    onAnswer={(body) => void sendMessage(cfg.id, body)}
                    answerable={cfg.activity === 'needs-clarification' && message.id === lastQuestionId}
                  />
                ))}
              </div>
            )}
          </div>

          {cfg.error && (
            <div className="mx-4 mb-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300" role="alert">
              {cfg.error}
            </div>
          )}

          {overBudget && (
            <div className="mx-4 mb-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200" role="alert">
              Token ceiling reached. Raise it in Settings, then resume.
            </div>
          )}

          <div className="glass-bar glass-bar--raised shrink-0 border-t px-4 py-3">
            <div className="mx-auto max-w-3xl">
              <textarea
                ref={composerRef}
                className="glass-input h-24 resize-none font-mono text-[12px] leading-relaxed"
                placeholder="Message Ravel. Enter sends; Shift+Enter adds a newline."
                value={composer}
                maxLength={MAX_MESSAGE_CHARS}
                onChange={(event) => setComposer(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    void submitMessage()
                  }
                }}
                disabled={busy}
                aria-label="Message Ravel"
              />
              <div className="mt-2 flex items-center gap-2">
                <span className="font-mono text-[10px] text-text-hint">{composer.length} / {MAX_MESSAGE_CHARS}</span>
                <span className="ml-auto hidden items-center gap-1 font-mono text-[10px] text-text-hint sm:inline-flex">
                  <CornerDownLeft size={11} /> Enter sends · Shift+Enter newline
                </span>
                <button className="btn-primary px-3 py-1.5" onClick={submitMessage} disabled={composer.trim().length === 0 || busy} aria-busy={busy}>
                  {busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                  Send
                </button>
              </div>
            </div>
          </div>
        </section>

        {rightTabs.length > 0 && (
          <ResizeHandle
            panel="ravelRail"
            edge="left"
            width={railWidth}
            absoluteAt={railWidth}
            onPreview={setRailDraft}
            onCommit={(next) => {
              setRailDraft(next)
              void saveSettings({ panelSizes: { ...panelSizes, ravelRail: next } })
            }}
          />
        )}
        {rightTabs.length > 0
          ? rail('right', rightTabs, activeTab, setTab)
          : dragTab !== null && emptyDock('right')}
      </div>
    </div>
  )
}

function MessageBubble({
  message,
  busy,
  onRetry,
  onAnswer,
  answerable
}: {
  message: RavelMessage
  busy: boolean
  onRetry: () => void
  onAnswer: (body: string) => void
  /** Only the newest question is still open; older ones were already answered. */
  answerable: boolean
}): JSX.Element {
  const isUser = message.author === 'user'
  const tone =
    message.author === 'system'
      ? 'text-text-low'
      : isUser
        ? 'border-cyan-300/20 bg-cyan-300/5 text-text-hi'
        : 'border-accent/20 bg-accent/5 text-text-hi'
  return (
    <article className={`glass-choice rounded-xl px-3 py-2 ${tone}`}>
      <div className="mb-1 flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-text-hint">
        <span className="inline-flex items-center gap-1">
          <span className={`h-1.5 w-5 rounded-full ${isUser ? 'bg-cyan-300/70' : message.author === 'ravel' ? 'bg-accent/80' : 'bg-text-hint'}`} />
          {message.author === 'user' ? 'You' : message.author === 'ravel' ? 'Ravel' : 'System'}
        </span>
        <span>{new Date(message.createdAt).toLocaleTimeString()}</span>
        <span className={`ml-auto ${message.delivery === 'failed' ? 'text-red-300' : message.delivery === 'pending' ? 'text-amber-300' : 'text-text-hint'}`}>
          {message.delivery}
        </span>
      </div>
      <div className="whitespace-pre-wrap text-sm leading-relaxed">{message.body}</div>
      {message.options !== undefined && message.options.length > 0 && answerable && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {message.options.map((option) => (
            <button
              key={option}
              className="btn-outline px-2 py-1 text-xs"
              disabled={busy}
              onClick={() => onAnswer(option)}
            >
              {option}
            </button>
          ))}
          <span className="self-center font-mono text-[10px] text-text-hint">or type your own answer</span>
        </div>
      )}
      {message.delivery === 'failed' && isUser && (
        <button className="btn-outline mt-2 px-2 py-1 text-xs" onClick={onRetry} disabled={busy}>
          <RefreshCw size={12} /> Retry
        </button>
      )}
    </article>
  )
}

function PlanTab({
  cfg,
  selectedRevision,
  setSelectedRevision,
  availableHarnesses,
  modelCatalogues,
  busy,
  canApprove,
  canMutatePlan,
  planCurrent,
  planApproved,
  changeRequest,
  setChangeRequest,
  onApprove,
  onRequestChanges,
  onAssignBrief,
  onClaimBrief
}: {
  cfg: PublicRavelConfig
  selectedRevision: number | null
  setSelectedRevision: (revision: number | null) => void
  availableHarnesses: HarnessId[]
  modelCatalogues: Record<HarnessId, HarnessCatalogue>
  busy: boolean
  canApprove: boolean
  canMutatePlan: boolean
  planCurrent: boolean
  planApproved: boolean
  changeRequest: string
  setChangeRequest: (value: string) => void
  onApprove: () => Promise<PublicRavelConfig | null> | undefined
  onRequestChanges: () => Promise<void>
  onAssignBrief: (briefId: string, assignment: { role?: ChildRavelRole; harness?: HarnessId }) => Promise<PublicRavelConfig | null> | undefined
  onClaimBrief: (briefId: string) => void
}): JSX.Element {
  const plan = cfg.plan
  if (!plan) {
    return (
      <div className="flex flex-col gap-3 p-3">
        <EmptyRailState title="No plan yet" body="Message Ravel to compile a structured mission plan. Child sessions cannot launch until you approve a current revision." />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="glass-choice border-accent/25 bg-accent/5 p-3">
        <div className="flex items-center gap-2">
          <ShieldCheck size={14} className="text-accent" />
          <div className="font-mono text-[11px] uppercase tracking-wider text-accent">Approval boundary</div>
        </div>
        <div className="mt-2 text-[12px] leading-relaxed text-text-mid">
          Approval is bound to revision {plan.revision}. Request changes clears approval before Ravel compiles a replacement, blocking further child launches until a replacement revision is approved.
        </div>
      </div>

      <div className="glass-panel p-3">
        <div className="mb-2 flex items-center gap-2">
          <div className="text-sm font-medium">Plan revision {plan.revision}</div>
          {planApproved && <span className="glass-pill h-auto rounded-full border-success/30 bg-success/10 px-2 py-0.5 font-mono text-[9px] text-success">Approved</span>}
        </div>
        <div className="grid grid-cols-2 gap-2 font-mono text-[10px] text-text-hint">
          <div>Created {new Date(plan.createdAt).toLocaleString()}</div>
          <div>Approved {plan.approvedAt ? new Date(plan.approvedAt).toLocaleString() : '—'}</div>
          <div>Approved revision {plan.approvedRevision ?? '—'}</div>
          <div>Sources {plan.sourceMessageIds.length ? plan.sourceMessageIds.join(', ') : '—'}</div>
        </div>
        <label className="mt-3 flex flex-col gap-1.5">
          <span className="label">Selected revision</span>
          <select className="glass-input" value={selectedRevision ?? ''} onChange={(event) => setSelectedRevision(Number(event.target.value))}>
            <option value={plan.revision}>Revision {plan.revision} (current)</option>
          </select>
        </label>
        {!planCurrent && <div className="mt-2 text-[11px] text-amber-300" role="alert">Select the current revision before changing or approving the plan.</div>}
      </div>

      <div className="glass-panel p-3">
        <div className="mb-2 text-sm font-medium">Mission</div>
        <TextField title="Goal" value={plan.mission.goal} />
        <ListField title="Context" items={plan.mission.context} />
        <ListField title="Constraints" items={plan.mission.constraints} />
        <ListField title="Acceptance criteria" items={plan.mission.acceptanceCriteria} />
        <ListField title="Assumptions" items={plan.mission.assumptions} />
      </div>

      <div className="flex flex-col gap-3">
        {plan.briefs.length === 0 ? (
          <EmptyRailState title="No briefs" body="Ravel must propose at least one role-scoped brief before dispatch." />
        ) : (
          plan.briefs.map((brief, index) => (
            <BriefCard
              key={brief.id}
              brief={brief}
              index={index}
              plan={plan}
              dispatches={cfg.dispatches}
              availableHarnesses={availableHarnesses}
              modelCatalogues={modelCatalogues}
              disabled={!canMutatePlan}
              onAssignBrief={onAssignBrief}
              claimable={planApproved}
              onClaimBrief={onClaimBrief}
            />
          ))
        )}
      </div>

      <div className="glass-panel p-3">
        <label className="flex flex-col gap-1.5">
          <span className="label">Request changes</span>
          <textarea
            className="glass-input h-24 resize-none font-mono text-[12px] leading-relaxed"
            value={changeRequest}
            onChange={(event) => setChangeRequest(event.target.value)}
            placeholder="Ask Ravel to revise roles, scope, constraints, dependencies, or acceptance criteria."
            disabled={busy || !planCurrent}
          />
        </label>
        <div className="mt-2 flex gap-2">
          <button className="btn-outline flex-1 px-3 py-1.5" disabled={busy || !planCurrent || changeRequest.trim().length === 0} onClick={onRequestChanges}>
            Request changes
          </button>
          <button className="btn-primary flex-1 px-3 py-1.5" disabled={!canApprove} onClick={onApprove} aria-busy={busy}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
            Approve plan
          </button>
        </div>
      </div>
    </div>
  )
}

function BriefCard({
  brief,
  index,
  plan,
  dispatches,
  availableHarnesses,
  modelCatalogues,
  disabled,
  claimable,
  onAssignBrief,
  onClaimBrief
}: {
  brief: RavelBrief
  index: number
  plan: PublicRavelConfig['plan'] & {}
  dispatches: RavelDispatchRecord[]
  availableHarnesses: HarnessId[]
  modelCatalogues: Record<HarnessId, HarnessCatalogue>
  disabled: boolean
  /** Only an approved plan can be worked, by an agent or by you. */
  claimable: boolean
  onAssignBrief: (
    briefId: string,
    assignment: { role?: ChildRavelRole; harness?: HarnessId; model?: string | null }
  ) => Promise<PublicRavelConfig | null> | undefined
  onClaimBrief: (briefId: string) => void
}): JSX.Element {
  const modelParts = splitModel(brief.model)
  const options = modelOptionsFor(modelCatalogues[brief.harness], modelParts.model)
  const live = dispatches.some(
    (dispatch) =>
      dispatch.briefId === brief.id &&
      (dispatch.status === 'starting' || dispatch.status === 'active')
  )
  const report =
    dispatches.find(
      (dispatch) =>
        dispatch.briefId === brief.id && dispatch.planRevision === plan.revision && dispatch.status === 'completed'
    )?.report ?? null

  const commitModel = (model: string, behavior: ThinkingLevel): void => {
    const composed = composeModel(model, behavior)
    if (composed === (brief.model ?? '')) return
    onAssignBrief(brief.id, { model: composed.length === 0 ? null : composed })
  }

  return (
    <article className="glass-panel overflow-hidden">
      <div className="glass-divider border-b bg-[var(--glass-inset-bg)] px-3 py-2">
        <div className="flex items-start gap-2">
          <span className="rounded-full border border-cyan-300/25 bg-cyan-300/10 px-2 py-0.5 font-mono text-[9px] text-cyan-200">#{index + 1}</span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{brief.title}</div>
            <div className="font-mono text-[10px] text-text-hint">{brief.id} · {brief.phase}</div>
          </div>
          {claimable && !live && (
            <button
              className="btn-outline shrink-0 px-2 py-1 text-[11px]"
              data-testid="claim-brief"
              title="Open a terminal on this brief and work it yourself"
              onClick={() => onClaimBrief(brief.id)}
            >
              <TerminalSquare size={12} /> Take it myself
            </button>
          )}
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1">
            <span className="label">Role</span>
            <select className="glass-input py-1.5 text-xs" value={brief.role} disabled={disabled} onChange={(event) => onAssignBrief(brief.id, { role: event.target.value as ChildRavelRole })}>
              {CHILD_ROLES.map((role) => (
                <option key={role} value={role}>{childRavelRoleLabel(role)}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="label">Harness</span>
            <select className="glass-input py-1.5 text-xs" value={brief.harness} disabled={disabled} onChange={(event) => onAssignBrief(brief.id, { harness: event.target.value as HarnessId })}>
              {availableHarnesses.map((harness) => (
                <option key={harness} value={harness}>{HARNESS_INFO[harness].label}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1">
            <span className="label">Model</span>
            <select
              className="glass-input py-1.5 text-xs"
              value={modelParts.model}
              disabled={disabled}
              aria-label={`Model for ${brief.title}`}
              onChange={(event) => commitModel(event.target.value, modelParts.behavior)}
            >
              <option value="">{defaultModelForRole(brief.role, brief.harness) ?? '(harness default)'} (auto)</option>
              {options.values.map((option) => (
                <option key={option} value={option}>
                  {option === options.unlisted ? `${option} (unlisted)` : option}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="label">Reasoning</span>
            <select
              className="glass-input py-1.5 text-xs"
              value={modelParts.behavior}
              disabled={disabled || !harnessSupportsBehavior(brief.harness) || modelParts.model.length === 0}
              aria-label={`Reasoning for ${brief.title}`}
              onChange={(event) => commitModel(modelParts.model, event.target.value as ThinkingLevel)}
            >
              {THINKING_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      <div className="p-3">
        <TextField title="Goal" value={brief.goal} />
        <ListField title="Relevant context" items={brief.relevantContext} />
        <ListField title="Constraints" items={brief.constraints} />
        <ListField title="Acceptance criteria" items={brief.acceptanceCriteria} />
        <ListField title="Do not touch" items={brief.doNotTouch} />
        <TextField title="Expected output" value={brief.expectedOutput} />
        <ListField title="Escalation conditions" items={brief.escalationConditions} />
        <ListField title="Depends on" items={brief.dependsOn.map((id) => `${id}${plan.briefs.find((item) => item.id === id)?.title ? ` — ${plan.briefs.find((item) => item.id === id)?.title}` : ''}`)} />
        <TextField title="Context exception reason" value={brief.contextExceptionReason ?? 'None'} />
        {report !== null && <TextField title="Report" value={report} />}
      </div>
    </article>
  )
}

function FleetTab({
  cfg,
  childSessions,
  sessions,
  busy,
  onOpenSession,
  onResumeInterrupted,
  onSteer
}: {
  cfg: PublicRavelConfig
  childSessions: Array<Extract<Session, { kind: 'ravel-child' }>>
  sessions: Session[]
  busy: boolean
  onOpenSession: (id: string) => void
  onResumeInterrupted: (record: RavelDispatchRecord) => Promise<PublicRavelConfig | null>
  onSteer: (sessionId: string, note: string) => Promise<PublicRavelConfig | null>
}): JSX.Element {
  // A session is dropped the moment its process exits, so a dispatch that
  // finished has no session left to render. Its record is the only surviving
  // evidence of what that child did — including the verify verdict — so the
  // tab synthesises a row from it rather than going blank when the fleet ends.
  const orphaned = cfg.dispatches.filter(
    (record) =>
      record.status !== 'starting' &&
      record.status !== 'active' &&
      !sessions.some((session) => session.id === record.sessionId)
  )
  const thinking = cfg.activity === 'thinking'
  return (
    <div className="flex flex-col gap-2 p-3">
      <FleetRow
        title="Ravel manager"
        role="On demand"
        harness={cfg.harness}
        branch="repo root"
        statusLabel={thinking ? 'Running a turn' : ravelActivityLabel(cfg.activity)}
        statusColor={thinking ? '#34c759' : '#6b6b76'}
        brief="Bounded per-event turn · no live session"
      />

      {childSessions.length === 0 && orphaned.length === 0 && (
        <EmptyRailState title="No children yet" body="Approved plans stay inspectable here. Ravel children appear only after the manager dispatches approved briefs." />
      )}

      {childSessions.map((session) => {
        const brief = cfg.plan?.briefs.find((item) => item.id === session.briefId)
        // By session id alone. Falling back to the brief id would find an
        // EARLIER dispatch of a re-run brief and paint this child with the
        // previous run's status, spend, and verify verdict.
        const dispatch = cfg.dispatches.find((item) => item.sessionId === session.id)
        const meta = STATUS_META[session.status]
        return (
          <FleetRow
            key={session.id}
            title={session.title ?? brief?.title ?? '(Ravel child)'}
            role={childRavelRoleLabel(session.ravelRole)}
            harness={session.harness}
            branch={session.branch}
            statusLabel={dispatch?.status ?? meta.label}
            statusColor={dispatch?.status === 'interrupted' ? '#ff9500' : meta.color}
            brief={`${session.briefId}${brief ? ` · ${brief.title}` : ''}`}
            onOpen={() => onOpenSession(session.id)}
            footer={`${timeAgo(session.lastActivityAt)} ago · ~${
              (dispatch?.usage.inputTokens ?? 0) + (dispatch?.usage.outputTokens ?? 0)
            } tok est. · ${session.worktreePath}`}
            verification={dispatch?.verification ?? null}
            action={<SteerChild sessionId={session.id} busy={busy} onSteer={onSteer} />}
          />
        )
      })}

      {orphaned.map((record) => {
        const brief = cfg.plan?.briefs.find((item) => item.id === record.briefId)
        const color =
          record.status === 'completed' ? '#32d4de' : record.status === 'failed' ? '#ef4444' : '#ff9500'
        return (
          <FleetRow
            key={`${record.planRevision}:${record.briefId}:${record.startedAt}`}
            title={brief?.title ?? record.briefId}
            role={brief ? childRavelRoleLabel(brief.role) : 'Ravel child'}
            harness={brief?.harness ?? cfg.harness}
            branch={record.branch}
            statusLabel={record.status}
            statusColor={color}
            brief={`Revision ${record.planRevision} · ${record.briefId}`}
            footer={`~${record.usage.inputTokens + record.usage.outputTokens} tok est. · ${record.worktreePath}`}
            verification={record.verification}
            action={
              record.status === 'interrupted' ? (
                <button className="btn-outline px-2 py-1 text-xs" disabled={busy} onClick={() => onResumeInterrupted(record)}>
                  <Play size={12} /> Resume brief
                </button>
              ) : undefined
            }
          />
        )
      })}

      {/* Keyed by Ravel: every result below belongs to one repository and one
          fleet, and none of it survives switching to another. */}
      <MergeReview key={cfg.id} cfg={cfg} busy={busy} />
    </div>
  )
}

/**
 * Review and land the branches this fleet produced.
 *
 * The preview colours a row; it never vetoes one. `mergeBranch` aborts and
 * restores the repository on conflict, so attempting a merge the preview
 * dislikes costs a refusal and nothing else — and a refusal with its
 * conflicting paths is better evidence than a greyed-out button.
 */
function MergeReview({ cfg, busy }: { cfg: PublicRavelConfig; busy: boolean }): JSX.Element | null {
  const previewMerge = useStore((s) => s.previewMerge)
  const landBranch = useStore((s) => s.landBranch)
  const deleteMergedBranch = useStore((s) => s.deleteMergedBranch)
  const rows = useMemo(() => mergeReviewRows(cfg), [cfg])
  const [baseBranch, setBaseBranch] = useState('')
  // Keyed by branch AND the dispatch that produced it AND the base it was
  // computed against: a re-dispatch moves the branch tip and a different base
  // is a different question, so neither may inherit the previous answer.
  const [preview, setPreview] = useState<{ key: string; result: MergePreviewResult } | null>(null)
  const [landed, setLanded] = useState<Record<string, LandedRecord>>({})
  const [open, setOpen] = useState(false)
  const [deleted, setDeleted] = useState<Record<string, true>>({})
  const [failures, setFailures] = useState<Record<string, string>>({})
  const [squash, setSquash] = useState(false)
  const base = baseBranch.trim()
  const rowKey = (row: MergeReviewRow): string => `${base}::${row.branch}::${row.startedAt}`
  const previewKey = `${base}::${squash}::${rows.map((row) => `${row.branch}@${row.startedAt}`).join(',')}`
  const current = preview !== null && preview.key === previewKey ? preview.result : null

  useEffect(() => {
    let cancelled = false
    // Replaces whatever was there: a base branch belongs to one repository, and
    // carrying the previous repository's over would land work on the wrong one.
    void window.api
      .currentBranch(cfg.repoPath)
      .then((branch) => {
        if (!cancelled && branch) setBaseBranch(branch)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [cfg.repoPath])

  if (rows.length === 0) return null

  const ready = base.length > 0 && !busy

  const runPreview = async (): Promise<void> => {
    const key = previewKey
    const result = await previewMerge(cfg.repoPath, rows.map((row) => row.branch), base)
    // Late answer to a question nobody is asking any more — the base or the
    // row set changed while it was in flight.
    setPreview((held) => (key === previewKey ? { key, result } : held))
  }

  const land = async (row: MergeReviewRow): Promise<void> => {
    const key = rowKey(row)
    const result = await landBranch(cfg.repoPath, row.branch, base, { squash })
    if (!result.ok) {
      setFailures((held) => ({ ...held, [key]: mergeFailureSummary(result) }))
      return
    }
    setLanded((held) => ({ ...held, [key]: { result, squashed: squash } }))
    setFailures((held) => {
      const next = { ...held }
      delete next[key]
      return next
    })
    // The base moved, so every other entry was computed against a commit that
    // is no longer the tip. Showing nothing is honest; showing the old verdict
    // is not.
    setPreview(null)
  }

  const removeBranch = async (row: MergeReviewRow): Promise<void> => {
    const key = rowKey(row)
    const result = await deleteMergedBranch(cfg.repoPath, row.branch)
    if (result.ok) setDeleted((held) => ({ ...held, [key]: true }))
    else setFailures((held) => ({ ...held, [key]: result.error }))
  }

  return (
    <section className="glass-panel mt-1 p-2.5">
      {/* Collapsed by default: finishing a fleet is a conversation, and the git
          mechanics are here for the moment you want them, not in the way. */}
      <button className="flex w-full items-center gap-2 text-left" onClick={() => setOpen((shown) => !shown)}>
        <GitMerge size={12} className="text-accent" />
        <span className="text-xs font-medium text-text-mid">Review and land</span>
        <span className="font-mono text-[10px] text-text-hint">
          {rows.length} finished {rows.length === 1 ? 'branch' : 'branches'}
        </span>
        <span className="ml-auto font-mono text-[10px] text-text-hint">{open ? 'hide' : 'show'}</span>
      </button>

      {open && (
      <>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1 font-mono text-[10px] text-text-hint">
          base
          <input
            className="glass-input h-6 w-40 font-mono text-[11px]"
            value={baseBranch}
            onChange={(event) => setBaseBranch(event.target.value)}
            placeholder="main"
          />
        </label>
        <label className="flex items-center gap-1 font-mono text-[10px] text-text-hint">
          <input type="checkbox" checked={squash} onChange={(event) => setSquash(event.target.checked)} />
          squash
        </label>
        <button className="btn-outline px-2 py-1 text-xs" disabled={!ready} onClick={runPreview}>
          <RefreshCw size={12} /> Preview all
        </button>
      </div>

      {current !== null && !current.ok && (
        <div className="mt-2 rounded border border-red-500/40 bg-red-500/10 px-2 py-1 font-mono text-[10px] text-red-300">
          {current.error}
        </div>
      )}

      <div className="mt-2 flex flex-col gap-2">
        {rows.map((row) => {
          const key = rowKey(row)
          const entry = current !== null && current.ok ? current.entries.find((item) => item.branch === row.branch) : undefined
          const record = landed[key]
          const state = reviewRowState(entry, record, deleted[key] === true)
          const overlap = entry ? overlapSummary(entry) : null
          const failure = failures[key]
          return (
            <div key={key} className="dense-surface rounded border p-2">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-xs text-text-mid">{row.title}</span>
                <span className="flex items-center gap-1 font-mono text-[9px]" style={{ color: state.color }}>
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: state.color }} /> {state.label}
                </span>
              </div>
              <div className="mt-1 flex items-center gap-2 font-mono text-[10px] text-text-hint">
                <GitBranch size={10} /> <span className="truncate">{row.branch}</span>
                <span>· {row.briefId} · rev {row.planRevision}</span>
              </div>

              {entry?.error !== null && entry?.error !== undefined && (
                <div className="mt-1 font-mono text-[10px] text-amber-300">{entry.error}</div>
              )}
              {entry && entry.files.length > 0 && (
                <div className="mt-1 font-mono text-[10px] text-text-hint">
                  {clipPaths(entry.files).join(', ')}
                </div>
              )}
              {entry && entry.conflictPaths.length > 0 && (
                <div className="mt-1 font-mono text-[10px] text-red-300">
                  conflicts: {clipPaths(entry.conflictPaths).join(', ')}
                </div>
              )}
              {overlap && <div className="mt-1 font-mono text-[10px] text-amber-300">{overlap}</div>}
              {record && <div className="mt-1 font-mono text-[10px] text-accent-cyan">{landedSummary(record)}</div>}
              {record?.result.warning && (
                <div className="mt-1 font-mono text-[10px] text-amber-300">{record.result.warning}</div>
              )}
              {failure && <div className="mt-1 font-mono text-[10px] text-red-300">{failure}</div>}

              <div className="mt-2 flex gap-2">
                <button
                  className="btn-outline px-2 py-1 text-xs"
                  disabled={!ready || !state.canLand}
                  onClick={() => land(row)}
                >
                  <GitMerge size={12} /> {squash ? 'Squash and land' : 'Land'}
                </button>
                {state.canDelete && (
                  <button
                    className="btn-outline px-2 py-1 text-xs"
                    disabled={busy}
                    onClick={() => removeBranch(row)}
                  >
                    <Trash2 size={12} /> Delete branch
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
      </>
      )}
    </section>
  )
}

function ActivityTab({ entries }: { entries: FleetActivityEntry[] }): JSX.Element {
  if (entries.length === 0) {
    return (
      <div className="p-3">
        <EmptyRailState
          title="No file activity yet"
          body="Files added, edited, or removed by this fleet's children — and by any terminal you have open on this repository — appear here as they happen."
        />
      </div>
    )
  }
  const tone: Record<SessionActivityEntry['kind'], string> = {
    added: 'text-success',
    edited: 'text-accent-cyan',
    removed: 'text-red-400'
  }
  return (
    <div className="flex flex-col gap-1 p-2">
      {entries.map(({ entry, session, manual }) => (
        <div
          key={entry.id}
          className={`glass-choice px-2 py-1.5 font-mono text-[11px] ${
            // Your own edits are marked: an unattributed row in a fleet feed
            // reads as "an agent did this", which would be wrong.
            manual ? 'border-l-2 border-l-accent/70' : ''
          }`}
        >
          <div className="flex items-center gap-2">
            <span className={`uppercase ${tone[entry.kind]}`}>{entry.kind}</span>
            <span className="min-w-0 flex-1 truncate text-text-hi">{entry.path}</span>
            <span className="text-text-hint">{timeAgo(entry.ts)}</span>
          </div>
          <div className="truncate text-[10px] text-text-hint">
            {manual ? 'you' : (session.title ?? session.branch)} · {agentInfo(session.harness).label}
          </div>
        </div>
      ))}
    </div>
  )
}

function LogTab({ entries }: { entries: Array<{ id: string; ravelId: string; ts: number; level: RavelLogLevel; event: string; childSessionId?: string; text: string }> }): JSX.Element {
  if (entries.length === 0) {
    return <div className="p-3"><EmptyRailState title="No log entries" body="Operational plan, dispatch, and manager turn events will appear here." /></div>
  }
  return (
    <div className="flex flex-col">
      {[...entries].reverse().map((entry) => (
        <div key={entry.id} className="dense-surface glass-divider border-b px-3 py-2">
          <div className="mb-1 flex items-center gap-2">
            <ScrollText size={11} style={{ color: LOG_COLOR[entry.level] }} />
            <span className="font-mono text-[10px] font-medium" style={{ color: LOG_COLOR[entry.level] }}>{entry.event}</span>
            <span className="ml-auto font-mono text-[9px] text-text-hint">{new Date(entry.ts).toLocaleString()}</span>
          </div>
          <div className="selectable whitespace-pre-wrap text-[11px] leading-snug text-text-low">{entry.text}</div>
          <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 font-mono text-[9px] text-text-hint">
            <dt>id</dt><dd className="truncate">{entry.id}</dd>
            <dt>ravelId</dt><dd className="truncate">{entry.ravelId}</dd>
            <dt>level</dt><dd>{entry.level}</dd>
            <dt>event</dt><dd className="truncate">{entry.event}</dd>
            <dt>childSessionId</dt><dd className="truncate">{entry.childSessionId ?? '—'}</dd>
          </dl>
        </div>
      ))}
    </div>
  )
}

const TURN_EVENTS: Record<string, true> = { turn: true, 'turn-empty': true }

/**
 * The manager has no terminal to show: it is a headless per-event invocation.
 * What is worth seeing is the turn transcript — prompt size, the tool calls it
 * produced, and the output of any turn that produced none.
 */
function ManagerTab({
  entries
}: {
  entries: Array<{ id: string; ts: number; level: RavelLogLevel; event: string; text: string }>
}): JSX.Element {
  const turns = entries.filter((entry) => TURN_EVENTS[entry.event] === true)
  if (turns.length === 0) {
    return (
      <div className="p-3">
        <EmptyRailState
          title="No manager turns yet"
          body="The manager runs one headless turn per event. Send a message, approve a plan, or wait for a child to exit."
        />
      </div>
    )
  }
  return (
    <div className="flex flex-col">
      {[...turns].reverse().map((entry) => (
        <div key={entry.id} className="dense-surface glass-divider border-b px-3 py-2">
          <div className="mb-1 flex items-center gap-2">
            <ScrollText size={11} style={{ color: LOG_COLOR[entry.level] }} />
            <span className="font-mono text-[10px] font-medium" style={{ color: LOG_COLOR[entry.level] }}>
              {entry.event}
            </span>
            <span className="ml-auto font-mono text-[9px] text-text-hint">{new Date(entry.ts).toLocaleTimeString()}</span>
          </div>
          <div className="selectable whitespace-pre-wrap font-mono text-[11px] leading-snug text-text-low">{entry.text}</div>
        </div>
      ))}
    </div>
  )
}

function FleetRow({
  title,
  role,
  harness,
  branch,
  statusLabel,
  statusColor,
  brief,
  footer,
  verification,
  onOpen,
  action
}: {
  title: string
  role: string
  /** null is the operator's own seat, not an agent. */
  harness: HarnessId | null
  branch: string
  statusLabel: string
  statusColor: string
  brief: string
  footer?: string
  /** The repo's own verdict on this child's worktree. Outranks what the child said. */
  verification?: DispatchVerification | null
  onOpen?: () => void
  action?: ReactNode
}): JSX.Element {
  const summary = (
    <>
      <div className="flex items-center gap-2">
        <HarnessBadge id={harness} size={18} />
        <span className="glass-pill h-auto rounded-full px-2 py-0.5 font-mono text-[9px]">{role}</span>
        <span className={`ml-auto flex items-center gap-1 font-mono text-[9px] ${statusLabel === 'active' || statusLabel === 'Running a turn' ? '!text-success' : ''}`} style={{ color: statusColor }}>
          <span className={`h-1.5 w-1.5 rounded-full ${statusLabel === 'active' || statusLabel === 'Running a turn' ? '!bg-success' : ''}`} style={{ background: statusColor }} /> {statusLabel}
        </span>
      </div>
      <div className="mt-1 truncate text-xs text-text-mid">{title}</div>
      <div className="mt-1 truncate font-mono text-[10px] text-text-hint">{brief}</div>
      <div className="mt-1 flex items-center gap-2 font-mono text-[10px] text-text-hint">
        <GitBranch size={10} /> <span className="truncate">{branch}</span>
      </div>
      {footer && <div className="mt-1 truncate font-mono text-[9px] text-text-hint">{footer}</div>}
      {verification && (
        <div
          className="mt-1 whitespace-pre-wrap break-words font-mono text-[9px]"
          style={{ color: verification.ok ? '#34c759' : '#ef4444' }}
        >
          {verification.ok ? 'verify passed' : 'verify failed'} · {verification.output.split('\n').slice(-3).join(' ')}
        </div>
      )}
    </>
  )

  // The action sits outside the open button, never inside it: a control nested
  // in a button is invalid markup and every click on it would also open the
  // session it belongs to.
  return (
    <div className="glass-panel p-2.5">
      {onOpen ? (
        <button className="group w-full text-left" onClick={onOpen}>
          {summary}
        </button>
      ) : (
        summary
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

/**
 * Steering is a note to the orchestrator about one child, not a message to the
 * child. The wording says so, because the difference is the whole boundary.
 */
function SteerChild({
  sessionId,
  busy,
  onSteer
}: {
  sessionId: string
  busy: boolean
  onSteer: (sessionId: string, note: string) => Promise<PublicRavelConfig | null>
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')

  if (!open) {
    return (
      <button className="btn-outline px-2 py-1 text-xs" disabled={busy} onClick={() => setOpen(true)}>
        <Send size={12} /> Steer
      </button>
    )
  }

  const submit = async (): Promise<void> => {
    const body = note.trim()
    if (body.length === 0 || busy) return
    const result = await onSteer(sessionId, body)
    if (result) {
      setNote('')
      setOpen(false)
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <textarea
        className="glass-input h-16 resize-none font-mono text-[11px]"
        placeholder="Tell Ravel what this child should do differently. Ravel decides what it hears."
        value={note}
        autoFocus
        aria-label="Steer this child"
        onChange={(event) => setNote(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            void submit()
          }
          if (event.key === 'Escape') setOpen(false)
        }}
      />
      <div className="flex gap-1.5">
        <button className="btn-primary px-2 py-1 text-xs" disabled={busy || note.trim().length === 0} onClick={submit}>
          <Send size={12} /> Send to Ravel
        </button>
        <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  )
}

function RailTab({
  tab,
  active,
  onSelect,
  icon,
  label,
  count,
  dragging,
  dropTarget,
  onDragStart,
  onDragEnter,
  onDrop,
  onDragEnd,
  onNudge,
  onDock
}: {
  tab: RavelTab
  active: RavelTab | null
  onSelect: (tab: RavelTab) => void
  icon: ReactNode
  label: string
  count?: number
  dragging: boolean
  dropTarget: boolean
  onDragStart: () => void
  onDragEnter: () => void
  onDrop: () => void
  onDragEnd: () => void
  onNudge: (delta: number) => void
  /** Send this panel to the other rail. */
  onDock: () => void
}): JSX.Element {
  return (
    <button
      draggable
      className={`flex min-w-0 cursor-grab items-center justify-center gap-1 py-2 text-xs font-medium transition-colors active:cursor-grabbing ${
        active === tab ? 'border-b-2 border-accent text-text-hi' : 'text-text-low hover:text-text-mid'
      } ${dragging ? 'opacity-40' : ''} ${dropTarget ? 'bg-accent/10' : ''}`}
      onClick={() => onSelect(tab)}
      data-testid={`ravel-tab-${tab}`}
      aria-pressed={active === tab}
      aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Alt+Shift+ArrowLeft"
      title={`${label} — drag to reorder or onto the other rail. Alt+Left / Alt+Right reorders, Alt+Shift+Left moves rail.`}
      onDragStart={(event) => {
        // A drag never starts without a payload on the transfer.
        event.dataTransfer.setData('text/plain', tab)
        event.dataTransfer.effectAllowed = 'move'
        onDragStart()
      }}
      onDragOver={(event) => {
        // Preventing the default is what marks this tab as a valid drop site.
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
      }}
      onDragEnter={onDragEnter}
      onDrop={(event) => {
        event.preventDefault()
        // The rail behind this tab is also a drop site; letting the event reach
        // it would re-dock the panel a second time on the same gesture.
        event.stopPropagation()
        onDrop()
      }}
      onDragEnd={onDragEnd}
      onKeyDown={(event) => {
        if (!event.altKey || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return
        event.preventDefault()
        if (event.shiftKey) onDock()
        else onNudge(event.key === 'ArrowLeft' ? -1 : 1)
      }}
    >
      {icon}
      <span className="truncate">{label}{typeof count === 'number' ? ` (${count})` : ''}</span>
    </button>
  )
}

function TextField({ title, value }: { title: string; value: string }): JSX.Element {
  return (
    <div className="mb-2">
      <div className="label mb-1">{title}</div>
      <div className="dense-surface selectable whitespace-pre-wrap rounded-md border px-2 py-1.5 text-[12px] leading-relaxed text-text-mid">{value || '—'}</div>
    </div>
  )
}

function ListField({ title, items }: { title: string; items: string[] }): JSX.Element {
  return (
    <div className="mb-2">
      <div className="label mb-1">{title}</div>
      {items.length === 0 ? (
        <div className="dense-surface rounded-md border px-2 py-1.5 font-mono text-[11px] text-text-hint">—</div>
      ) : (
        <ul className="dense-surface selectable space-y-1 rounded-md border px-2 py-1.5 text-[12px] leading-relaxed text-text-mid">
          {items.map((item, index) => (
            <li key={`${title}:${index}`} className="flex gap-2">
              <span className="mt-2 h-px w-3 shrink-0 bg-gradient-to-r from-accent/60 to-cyan-300/40" />
              <span className="whitespace-pre-wrap">{item}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function StatusPill({ color, pulse, children }: { color: string; pulse: boolean; children: ReactNode }): JSX.Element {
  return (
    <span className="glass-pill h-auto shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px]" style={{ color }}>
      <span className={`h-1.5 w-1.5 rounded-full ${pulse ? 'animate-pulse' : ''}`} style={{ background: color }} />
      {children}
    </span>
  )
}

function EmptyRailState({ title, body }: { title: string; body: string }): JSX.Element {
  return (
    <div className="glass-panel rounded-md border-dashed px-3 py-6 text-center">
      <AlertTriangle size={18} className="mx-auto mb-2 text-text-hint" />
      <div className="text-sm text-text-mid">{title}</div>
      <div className="mt-1 font-mono text-[11px] leading-relaxed text-text-hint">{body}</div>
    </div>
  )
}

function isRavelChildFor(ravelId: string): (session: Session) => session is Extract<Session, { kind: 'ravel-child' }> {
  return (session: Session): session is Extract<Session, { kind: 'ravel-child' }> => session.kind === 'ravel-child' && session.ravelId === ravelId
}
