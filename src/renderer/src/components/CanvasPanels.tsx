import {
  ArrowUpRight,
  MessageCircle,
  Pause,
  Play,
  Plus,
  Sparkles
} from 'lucide-react'
import { formatCost, formatTokens, selectFleetMeter, type MeterLevel } from '../lib/fleetMeter'
import { useStore } from '../store/useStore'
import { SessionCard } from './SessionCard'
/**
 * Bodies of the three standing canvas panels.
 *
 * They render CONTENT ONLY: the plate, the header, the drag grip and the close
 * and minimize controls all belong to CanvasFrame, so every panel on the canvas
 * — including a whole Ravel view — behaves identically.
 */



/** The small, quiet "new …" control in a panel head. */
function PanelAction({
  label,
  testId,
  icon,
  disabled,
  onClick
}: {
  label: string
  testId: string
  icon: JSX.Element
  disabled?: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      aria-label={label}
      title={disabled ? 'Add a repository first' : label}
      className="grid h-[18px] w-[18px] place-items-center rounded-[5px] text-text-low hover:bg-white/[0.08] hover:text-text-hi disabled:cursor-not-allowed disabled:opacity-35"
    >
      {icon}
    </button>
  )
}

export function SessionsPanel(): JSX.Element {
  const sessions = useStore((s) => s.sessions)
  const activeId = useStore((s) => s.selectedSessionId)
  const repos = useStore((s) => s.repos)
  const toggleNewSession = useStore((s) => s.toggleNewSession)

  return (
    <div data-testid="glass-sessions-panel" className="flex h-full flex-col overflow-y-auto">
      <div className="flex shrink-0 justify-end px-2 pt-2">
        <PanelAction
          label="New session"
          testId="new-session"
          icon={<Plus size={12} />}
          disabled={repos.length === 0}
          onClick={() => toggleNewSession(true)}
        />
      </div>
      {sessions.length === 0 && (
        <div className="px-3.5 py-4 text-[11.5px] text-text-low">No sessions yet.</div>
      )}
      <div className="flex flex-col gap-1.5 p-2">
        {sessions.slice(0, 6).map((session) => (
          <SessionCard
            key={session.id}
            session={session}
            compact
            selected={session.id === activeId}
            testId="glass-session-row"
          />
        ))}
      </div>
    </div>
  )
}

const TAG: Record<string, string> = {
  running: 'bg-[#3ddc97]/15 text-[#5fe3ae] border-[#3ddc97]/30',
  verifying: 'bg-[#8b7cf6]/[0.16] text-[#b5aaff] border-[#8b7cf6]/[0.34]',
  queued: 'bg-white/[0.06] text-text-low border-white/[0.14]'
}

export function WorkPanel(): JSX.Element {
  const ravelList = useStore((s) => s.ravelList)
  const openRavel = useStore((s) => s.openRavel)
  const roundtables = useStore((s) => s.roundtables)
  const openRoundtable = useStore((s) => s.openRoundtable)
  const repos = useStore((s) => s.repos)
  const toggleNewRavel = useStore((s) => s.toggleNewRavel)
  const toggleNewRoundtable = useStore((s) => s.toggleNewRoundtable)
  const rows = ravelList.slice(0, 4)
  const tables = roundtables.slice(0, 3)

  return (
    <div data-testid="glass-work-panel" className="flex h-full flex-col overflow-y-auto">
      <div className="flex shrink-0 justify-end gap-1.5 px-2 pt-2">
        <>
            <PanelAction
              label="New Reigen"
              testId="new-ravel"
              icon={<Sparkles size={11} />}
              disabled={repos.length === 0}
              onClick={() => toggleNewRavel(true)}
            />
            <PanelAction
              label="New Roundtable"
              testId="new-roundtable"
              icon={<MessageCircle size={11} />}
              disabled={repos.length === 0}
              onClick={() => toggleNewRoundtable(true)}
            />
        </>
      </div>
      {rows.length === 0 && tables.length === 0 && (
        <div className="px-3.5 py-4 text-[11.5px] text-text-low">Nothing dispatched.</div>
      )}
      {rows.map((r) => {
        const state =
          r.activity === 'thinking' ? 'running' : r.status === 'awaiting-approval' ? 'verifying' : 'queued'
        return (
          <button
            key={r.id}
            onClick={() => openRavel(r.id)}
            data-testid="glass-ravel-row"
            className="block w-full border-b border-white/[0.045] px-3.5 py-2.5 text-left last:border-0 hover:bg-white/[0.045]"
          >
            <span className="flex items-center justify-between gap-2">
              <span className="truncate text-[11.5px] text-text-hi">{r.name}</span>
              <span
                className={`shrink-0 rounded-[5px] border px-1.5 py-px text-[9px] font-semibold uppercase tracking-[0.05em] ${TAG[state]}`}
              >
                {state}
              </span>
            </span>
            <span className="mt-2 block h-[3px] overflow-hidden rounded-sm bg-white/[0.09]">
              <i
                className="block h-full rounded-sm bg-gradient-to-r from-[#6d5fd4] to-[#8b7cf6]"
                style={{ width: state === 'running' ? '64%' : state === 'verifying' ? '88%' : '0%' }}
              />
            </span>
            <span className="mt-1.5 block truncate text-[10px] text-text-low">{r.repoPath ?? r.status}</span>
          </button>
        )
      })}
      {tables.map((t) => (
        <button
          key={t.id}
          onClick={() => openRoundtable(t.id)}
          data-testid="glass-roundtable-row"
          className="flex w-full items-center gap-2 border-b border-white/[0.045] px-3.5 py-2.5 text-left last:border-0 hover:bg-white/[0.045]"
        >
          <MessageCircle
            size={12}
            className={`shrink-0 ${t.status === 'running' ? 'text-[#8b7cf6]' : 'text-text-low'}`}
          />
          <span className="min-w-0 flex-1 truncate text-[11.5px] text-text-hi">{t.name}</span>
          <span className="shrink-0 text-[9px] uppercase tracking-[0.05em] text-text-low">{t.status}</span>
        </button>
      ))}
    </div>
  )
}

/** Ceilings are set in tens of thousands, so the chips are too. Infinity disables it. */
const CEILING_PRESETS = [50_000, 100_000, 250_000, 0] as const

const RING: Record<MeterLevel, { stroke: string; glow: string; text: string }> = {
  idle: { stroke: 'stroke-white/[0.14]', glow: '', text: 'text-text-low' },
  ok: {
    stroke: 'stroke-[rgb(var(--accent))]',
    glow: 'drop-shadow-[0_0_7px_rgba(139,124,246,0.55)]',
    text: 'text-white'
  },
  warn: {
    stroke: 'stroke-[#f0b429]',
    glow: 'drop-shadow-[0_0_7px_rgba(240,180,41,0.5)]',
    text: 'text-[#ffd479]'
  },
  breach: {
    stroke: 'stroke-[#ef4444]',
    glow: 'drop-shadow-[0_0_8px_rgba(239,68,68,0.55)]',
    text: 'text-[#ff8f8f]'
  }
}

/**
 * Spend against the ceiling, as the largest thing on the canvas.
 *
 * This slot used to hold a Pomodoro timer whose Start button had no handler and
 * whose ring was frozen at a hardcoded offset. `tokenCeilingPerRavel` is the only
 * mechanism that stops a runaway child, and it was reachable only from Settings —
 * so the biggest widget on the dashboard is now the one that stops you spending.
 */
export function FleetMeter(): JSX.Element {
  const ravelList = useStore((s) => s.ravelList)
  const sessions = useStore((s) => s.sessions)
  const ceiling = useStore((s) => s.settings.tokenCeilingPerRavel)
  const saveSettings = useStore((s) => s.saveSettings)
  const openRavel = useStore((s) => s.openRavel)
  const pauseRavel = useStore((s) => s.pauseRavel)
  const resumeRavel = useStore((s) => s.resumeRavel)

  const meter = selectFleetMeter(ravelList, sessions, ceiling)
  const circumference = 2 * Math.PI * 58
  const skin = RING[meter.level]
  const focus = meter.ravel

  return (
    <div
      data-testid="fleet-meter"
      className="flex h-full flex-col items-center overflow-y-auto px-3.5 pb-4 pt-3"
    >
      <div className="mb-2.5 w-full truncate text-center text-[11px] text-text-low">
        {focus === null ? 'Nothing dispatched' : focus.name}
      </div>

      <div className="relative mb-3 h-[132px] w-[132px]">
        <svg width="132" height="132" className="-rotate-90">
          <circle cx="66" cy="66" r="58" fill="none" strokeWidth="7" className="stroke-white/[0.08]" />
          {meter.ratio !== null && (
            <circle
              cx="66"
              cy="66"
              r="58"
              fill="none"
              strokeWidth="7"
              strokeLinecap="round"
              strokeDasharray={circumference}
              // The arc is the UNSPENT remainder pushed out of view, so a full
              // ring means the ceiling has been reached.
              strokeDashoffset={circumference * (1 - meter.ratio)}
              className={`${skin.stroke} ${skin.glow} transition-[stroke-dashoffset] duration-500`}
            />
          )}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className={`font-mono text-[27px] leading-none tracking-wide ${skin.text}`}>
            {formatTokens(meter.spent)}
          </span>
          <span className="mt-1 text-[9px] uppercase tracking-[0.18em] text-text-low">
            {ceiling > 0 ? `of ${formatTokens(ceiling)} tok` : 'tok est.'}
          </span>
          {focus !== null && (
            <span className="mt-1 font-mono text-[10px] text-text-low">{formatCost(meter.costUsd)}</span>
          )}
        </div>
      </div>

      <div className="mb-3 flex gap-1.5">
        {CEILING_PRESETS.map((n) => (
          <button
            key={n}
            onClick={() => void saveSettings({ tokenCeilingPerRavel: n })}
            title={n === 0 ? 'No ceiling' : `Pause each ravel at ${formatTokens(n)} estimated tokens`}
            className={`rounded-[7px] border px-2 py-1 text-[10.5px] ${
              ceiling === n
                ? 'border-accent/40 bg-accent/20 text-[#d3ccff]'
                : 'border-transparent bg-white/[0.045] text-text-low hover:bg-white/[0.08]'
            }`}
          >
            {n === 0 ? '∞' : formatTokens(n)}
          </button>
        ))}
      </div>

      {focus === null ? (
        <span className="text-[10.5px] text-text-low">Nothing dispatched</span>
      ) : (
        // Keyed by the focus ravel: when spend moves the ring onto a different
        // ravel, React remounts these buttons and a click already in flight is
        // cancelled rather than landing on a target that is no longer displayed.
        <div key={focus.id} className="flex items-center gap-2.5">
          {meter.action === 'none' ? (
            <span className="text-[10.5px] capitalize text-text-low">{focus.status}</span>
          ) : (
            <button
              onClick={() =>
                void (meter.action === 'pause' ? pauseRavel(focus.id) : resumeRavel(focus.id))
              }
              disabled={meter.action === 'resume-blocked'}
              aria-label={`${meter.action === 'pause' ? 'Pause' : 'Resume'} ${focus.name}`}
              title={
                meter.action === 'resume-blocked'
                  ? `${focus.name} is at its ceiling — raise it above ${formatTokens(meter.spent)} first`
                  : meter.action === 'pause'
                    ? `Stop ${focus.name} and every live child`
                    : `Resume ${focus.name}`
              }
              className="flex items-center gap-1.5 rounded-[9px] bg-accent/90 px-4 py-2 text-[12.5px] font-medium text-white shadow-[0_5px_18px_rgba(139,124,246,0.42)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
            >
              {meter.action === 'pause' ? (
                <Pause size={12} fill="currentColor" />
              ) : (
                <Play size={12} fill="currentColor" />
              )}
              {meter.action === 'pause' ? 'Pause' : 'Resume'}
            </button>
          )}
          <button
            onClick={() => openRavel(focus.id)}
            aria-label={`Open ${focus.name}`}
            title={`Open ${focus.name}`}
            className="grid h-[30px] w-[30px] place-items-center rounded-full border border-white/[0.14] bg-white/[0.06] text-text-low hover:text-text-hi"
          >
            <ArrowUpRight size={14} />
          </button>
        </div>
      )}

      <div className="mt-2.5 text-[10px] text-text-low">
        {meter.ravelCount} ravel{meter.ravelCount === 1 ? '' : 's'} · {meter.liveSessionCount} live
      </div>
    </div>
  )
}
