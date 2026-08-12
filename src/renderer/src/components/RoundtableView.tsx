import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  CornerDownLeft,
  Loader2,
  MessageCircle,
  Pause,
  Play,
  Send,
  Sparkles,
  Trash2
} from 'lucide-react'
import {
  agentInfo,
  type RavelUsage,
  type RoundtableSeat,
  type RoundtableTurn
} from '@shared/types'
import { useStore } from '../store/useStore'
import { activityStateOfRoundtable } from '../lib/activityState'
import { ActivityBadge } from './ActivityBadge'
import { AgentIcon } from './AgentIcon'

export function RoundtableView({ roundtableId }: { roundtableId?: string } = {}): JSX.Element {
  const roundtables = useStore((state) => state.roundtables)
  const storeSelected = useStore((state) => state.selectedRoundtableId)
  const selectedId = roundtableId ?? storeSelected
  const repos = useStore((state) => state.repos)
  const harnesses = useStore((state) => state.harnesses)
  const settings = useStore((state) => state.settings)
  const busy = useStore((state) => state.busy)
  const back = useStore((state) => state.back)
  const startRoundtable = useStore((state) => state.startRoundtable)
  const pauseRoundtable = useStore((state) => state.pauseRoundtable)
  const addNote = useStore((state) => state.addRoundtableNote)
  const deleteRoundtable = useStore((state) => state.deleteRoundtable)
  const createRavel = useStore((state) => state.createRavel)
  const cfg = roundtables.find((item) => item.id === selectedId)
  const [composer, setComposer] = useState('')
  const transcriptRef = useRef<HTMLDivElement>(null)

  const orderedTurns = useMemo(
    () => [...(cfg?.turns ?? [])].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
    [cfg?.turns]
  )

  useEffect(() => {
    setComposer('')
  }, [cfg?.id])

  useEffect(() => {
    const transcript = transcriptRef.current
    if (transcript) transcript.scrollTop = transcript.scrollHeight
  }, [orderedTurns.length, orderedTurns.at(-1)?.body, cfg?.conclusion, cfg?.status])

  if (!cfg) return <div className="p-6 text-sm text-text-low">No debate selected.</div>

  const repo = repos.find((item) => item.id === cfg.repoId)
  const modelTurns = orderedTurns.filter((turn) => turn.seatId !== null)
  const canStart =
    cfg.status !== 'running' &&
    cfg.conclusion === null &&
    modelTurns.length < cfg.maxTurns &&
    !busy
  const availableHarnesses = harnesses.filter((item) => item.available)
  const ravelHarness = availableHarnesses.some((item) => item.id === settings.defaultHarness)
    ? settings.defaultHarness
    : availableHarnesses[0]?.id
  const nextSeat = cfg.status === 'running' ? expectedNextSeat(cfg.seats, modelTurns) : null

  const submitNote = async (): Promise<void> => {
    const body = composer.trim()
    if (!body || busy) return
    const result = await addNote(cfg.id, body)
    if (result) setComposer('')
  }

  const onDelete = async (): Promise<void> => {
    if (confirm(`Delete debate "${cfg.name}"?\n\nIts transcript and conclusion will be removed.`)) {
      await deleteRoundtable(cfg.id)
    }
  }

  const sendToRavel = async (): Promise<void> => {
    if (!cfg.conclusion || !ravelHarness || busy) return
    await createRavel({
      name: `${cfg.name} strategy`,
      repoId: cfg.repoId,
      repoPath: cfg.repoPath,
      harness: ravelHarness,
      initialInstruction: cfg.conclusion
    })
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="glass-bar shrink-0 border-b px-4 py-2.5">
        <div className="flex items-center gap-3">
          <button className="btn-ghost px-2" onClick={back} data-testid="back" title="Back" aria-label="Back">
            <ArrowLeft size={16} />
          </button>
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-xl border border-accent/25 bg-accent/10 text-accent">
            <MessageCircle size={16} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <div className="truncate text-sm font-semibold">{cfg.name}</div>
              <span className="glass-pill h-auto rounded-full px-2 py-0.5 font-mono text-[10px]">
                <ActivityBadge state={activityStateOfRoundtable(cfg)} />
                {cfg.status.charAt(0).toUpperCase() + cfg.status.slice(1)}
              </span>
              <span className="glass-pill h-auto rounded-full px-2 py-0.5 font-mono text-[10px] text-cyan-200">
                {formatUsage(cfg.usage)}
              </span>
            </div>
            <div className="truncate font-mono text-[10px] text-text-hint">
              {repo?.name ?? cfg.repoId} · {modelTurns.length} / {cfg.maxTurns} turns
            </div>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {cfg.status === 'running' ? (
              <button
                className="btn-outline px-2.5"
                onClick={() => void pauseRoundtable(cfg.id)}
                disabled={busy}
              >
                <Pause size={14} /> Pause
              </button>
            ) : (
              <button
                className="btn-primary px-2.5"
                onClick={() => void startRoundtable(cfg.id)}
                disabled={!canStart}
              >
                <Play size={14} /> {cfg.status === 'paused' ? 'Resume' : 'Start'}
              </button>
            )}
            <button
              className="btn-ghost px-2 text-text-hint hover:text-red-400"
              onClick={() => void onDelete()}
              disabled={busy}
              title="Delete debate"
              aria-label="Delete debate"
            >
              <Trash2 size={15} />
            </button>
          </div>
        </div>

        <div className="mt-2 grid grid-cols-2 gap-2 pl-11 max-[680px]:grid-cols-1">
          {cfg.seats.map((seat) => (
            <SeatSummary
              key={seat.id}
              seat={seat}
              usage={usageForSeat(orderedTurns, seat.id)}
            />
          ))}
        </div>
      </header>

      <section className="conversation-surface flex min-h-0 flex-1 flex-col">
        <div className="border-b glass-divider px-4 py-2.5">
          <div className="mx-auto flex max-w-4xl items-start gap-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-text-hint">Topic</span>
            <span className="selectable text-xs leading-relaxed text-text-mid">{cfg.topic}</span>
          </div>
        </div>

        <div
          ref={transcriptRef}
          className="selectable min-h-0 flex-1 overflow-y-auto px-4 py-5"
          aria-label="Debate conversation"
          aria-live="polite"
        >
          <div className="mx-auto flex max-w-4xl flex-col gap-3">
            {orderedTurns.length === 0 && cfg.status !== 'running' && (
              <div className="glass-panel mx-auto my-8 max-w-md border-dashed px-5 py-6 text-center">
                <MessageCircle size={24} className="mx-auto mb-3 text-accent" />
                <div className="text-sm text-text-mid">The seats are ready.</div>
                <div className="mt-1 font-mono text-[11px] text-text-hint">
                  Start to watch each complete turn land here in strict rotation.
                </div>
              </div>
            )}

            {orderedTurns.map((turn) => {
              const seatIndex = turn.seatId === null
                ? -1
                : cfg.seats.findIndex((candidate) => candidate.id === turn.seatId)
              const seat = seatIndex === -1 ? null : cfg.seats[seatIndex]
              return (
                <TurnBubble
                  key={turn.id}
                  turn={turn}
                  seat={seat}
                  lane={seat === null || seatIndex % 2 === 1 ? 'right' : 'left'}
                />
              )
            })}

            {nextSeat && (
              <TypingIndicator
                seat={nextSeat}
                lane={cfg.seats.findIndex((seat) => seat.id === nextSeat.id) % 2 === 1 ? 'right' : 'left'}
              />
            )}

            {(cfg.conclusion !== null || cfg.status === 'concluded') && (
              <section
                data-testid="debate-conclusion"
                className="mx-auto mt-3 w-full max-w-3xl overflow-hidden rounded-2xl border border-cyan-300/35 bg-cyan-300/[0.09] shadow-[0_16px_60px_rgba(34,211,238,0.08)]"
              >
                <div className="flex items-center gap-2 border-b border-cyan-300/20 px-4 py-2.5 text-xs font-semibold uppercase tracking-[0.16em] text-cyan-200">
                  <Sparkles size={14} /> Conclusion
                </div>
                <div className="whitespace-pre-wrap px-4 py-4 text-sm leading-relaxed text-text-hi">
                  {cfg.conclusion ?? 'The debate concluded without a final statement.'}
                </div>
                {cfg.conclusion && (
                  <div className="flex justify-end border-t border-cyan-300/15 px-4 py-3">
                    <button
                      className="btn-primary"
                      onClick={() => void sendToRavel()}
                      disabled={busy || !ravelHarness}
                      title={!ravelHarness ? 'No harness is available for a new Reigen' : undefined}
                    >
                      <Sparkles size={14} /> Send to Reigen
                    </button>
                  </div>
                )}
              </section>
            )}
          </div>
        </div>

        {cfg.status === 'paused' && (
          <div className="mx-4 mb-2 flex items-center gap-2 rounded-lg border border-amber-400/25 bg-amber-400/[0.08] px-3 py-2 text-xs text-amber-100">
            <ActivityBadge state="idle" />
            Debate paused. Resume when you are ready for the next seat.
          </div>
        )}

        {(cfg.status === 'error' || cfg.error !== null) && (
          <div
            className="mx-4 mb-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300"
            role="alert"
          >
            {cfg.error ?? 'The debate stopped because a seat failed.'}
          </div>
        )}

        <div className="glass-bar glass-bar--raised shrink-0 border-t px-4 py-3">
          <div className="mx-auto max-w-4xl">
            <textarea
              className="glass-input h-20 resize-none font-mono text-[12px] leading-relaxed"
              placeholder="Add operator context between turns. Enter sends; Shift+Enter adds a newline."
              value={composer}
              onChange={(event) => setComposer(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  void submitNote()
                }
              }}
              disabled={busy}
              aria-label="Note to the debate"
            />
            <div className="mt-2 flex items-center gap-2">
              <span className="font-mono text-[10px] text-text-hint">
                Your note joins the conversation without using a model turn.
              </span>
              <span className="ml-auto hidden items-center gap-1 font-mono text-[10px] text-text-hint sm:inline-flex">
                <CornerDownLeft size={11} /> Enter sends
              </span>
              <button
                className="btn-primary px-3 py-1.5"
                onClick={() => void submitNote()}
                disabled={composer.trim().length === 0 || busy}
                aria-busy={busy}
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                Send note
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}

function SeatSummary({ seat, usage }: { seat: RoundtableSeat; usage: RavelUsage }): JSX.Element {
  const info = agentInfo(seat.harness)
  return (
    <div
      className="flex min-w-0 items-center gap-2 rounded-xl border px-2.5 py-2"
      style={{
        borderColor: `color-mix(in srgb, ${info.accent} 30%, transparent)`,
        background: `color-mix(in srgb, ${info.accent} 8%, transparent)`
      }}
      title={seat.stance || 'No fixed stance'}
    >
      <AgentIcon harness={seat.harness} size={13} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11px] font-semibold">{seat.name}</div>
        <div className="truncate font-mono text-[9px] text-text-hint">
          {seat.model ?? `${info.label} default`}
        </div>
      </div>
      <span
        data-testid={`seat-cost-${seat.id}`}
        className="shrink-0 font-mono text-[9px]"
        style={{ color: info.accent }}
      >
        {formatUsage(usage)}
      </span>
    </div>
  )
}

function TurnBubble({
  turn,
  seat,
  lane
}: {
  turn: RoundtableTurn
  seat: RoundtableSeat | null
  lane: 'left' | 'right'
}): JSX.Element {
  const harness = seat?.harness ?? null
  const info = agentInfo(harness)
  const label = seat ? `${seat.name} · ${seat.model ?? `${info.label} default`}` : 'You · operator'
  return (
    <article
      data-testid={`turn-${turn.id}`}
      data-lane={lane}
      className={`flex ${lane === 'right' ? 'justify-end' : 'justify-start'}`}
    >
      <div
        className={`max-w-[82%] rounded-2xl border px-3.5 py-3 ${
          lane === 'right' ? 'rounded-br-md' : 'rounded-bl-md'
        }`}
        style={{
          borderColor: `color-mix(in srgb, ${info.accent} 38%, transparent)`,
          background: `color-mix(in srgb, ${info.accent} 11%, rgb(var(--bg-1)))`,
          boxShadow: `0 10px 28px color-mix(in srgb, ${info.accent} 7%, transparent)`
        }}
      >
        <div className="mb-2 flex items-center gap-2">
          <AgentIcon harness={harness} size={12} />
          <span className="font-mono text-[10px] font-semibold" style={{ color: info.accent }}>
            {label}
          </span>
          <span className="ml-auto font-mono text-[9px] text-text-hint">{formatUsage(turn.usage)}</span>
        </div>
        <div className="whitespace-pre-wrap text-sm leading-relaxed text-text-mid">{turn.body}</div>
      </div>
    </article>
  )
}

function TypingIndicator({
  seat,
  lane
}: {
  seat: RoundtableSeat
  lane: 'left' | 'right'
}): JSX.Element {
  const accent = agentInfo(seat.harness).accent
  return (
    <div
      className={`flex ${lane === 'right' ? 'justify-end' : 'justify-start'}`}
      data-testid="debate-typing"
    >
      <div
        className="flex items-center gap-2 rounded-full border px-3 py-2"
        style={{
          borderColor: `color-mix(in srgb, ${accent} 28%, transparent)`,
          background: `color-mix(in srgb, ${accent} 8%, transparent)`
        }}
      >
        <AgentIcon harness={seat.harness} size={11} />
        <ActivityBadge state="working" />
        <span className="text-[11px] text-text-low">{seat.name} is typing…</span>
        <span className="flex items-end gap-0.5" aria-hidden>
          <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:-0.2s]" />
          <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:-0.1s]" />
          <span className="h-1 w-1 animate-bounce rounded-full bg-current" />
        </span>
      </div>
    </div>
  )
}

function expectedNextSeat(seats: RoundtableSeat[], modelTurns: RoundtableTurn[]): RoundtableSeat | null {
  if (seats.length === 0) return null
  const lastSeatId = modelTurns.at(-1)?.seatId
  if (lastSeatId === undefined || lastSeatId === null) return seats[0]
  const lastIndex = seats.findIndex((seat) => seat.id === lastSeatId)
  return seats[(lastIndex + 1) % seats.length]
}

function usageForSeat(turns: RoundtableTurn[], seatId: string): RavelUsage {
  let inputTokens = 0
  let outputTokens = 0
  let costUsd = 0
  let hasSeatTurn = false
  let hasUnknownCost = false
  for (const turn of turns) {
    if (turn.seatId !== seatId) continue
    hasSeatTurn = true
    inputTokens += turn.usage.inputTokens
    outputTokens += turn.usage.outputTokens
    if (turn.usage.costUsd === null) hasUnknownCost = true
    else costUsd += turn.usage.costUsd
  }
  return {
    inputTokens,
    outputTokens,
    costUsd: hasSeatTurn && !hasUnknownCost ? costUsd : null
  }
}

function formatUsage(usage: RavelUsage): string {
  const tokens = usage.inputTokens + usage.outputTokens
  return `${tokens.toLocaleString()} tok${usage.costUsd === null ? '' : ` · $${usage.costUsd.toFixed(2)}`}`
}
