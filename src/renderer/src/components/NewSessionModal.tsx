import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  agentInfo,
  applyBehaviorToPrompt,
  BEHAVIOR_LABELS,
  MAX_ROUNDTABLE_TURNS,
  modelOptionsFor,
  SESSION_BEHAVIORS,
  type HarnessAvailability,
  type HarnessCatalogue,
  type HarnessId,
  type SessionBehavior
} from '@shared/types'
import { Loader2, MessageCircle, Sparkles, Users, X } from 'lucide-react'
import { defaultHarnessId, useStore } from '../store/useStore'
import { AgentIcon } from './AgentIcon'

type LauncherMode = 'session' | 'debate'

interface NewSessionModalProps {
  initialMode?: LauncherMode
  onClose?: () => void
}

interface SeatDraft {
  name: string
  harness: HarnessId
  model: string
  stance: string
}

const DEFAULT_DEBATE_TURNS = 4

export function slugBranchLabel(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '')
  return slug || 'session'
}

function uniqueBranchSuffix(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(3))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}


export function NewSessionModal({
  initialMode = 'session',
  onClose
}: NewSessionModalProps = {}): JSX.Element {
  const repos = useStore((state) => state.repos)
  const harnesses = useStore((state) => state.harnesses)
  const modelCatalogues = useStore((state) => state.modelCatalogues)
  const ensureModelCatalogues = useStore((state) => state.ensureModelCatalogues)
  const settings = useStore((state) => state.settings)
  const newSessionPreset = useStore((state) => state.newSessionPreset)
  const createSession = useStore((state) => state.createSession)
  const createRoundtable = useStore((state) => state.createRoundtable)
  const startRoundtable = useStore((state) => state.startRoundtable)
  const openSession = useStore((state) => state.openSession)
  const busy = useStore((state) => state.busy)
  const error = useStore((state) => state.error)
  const toggleNewSession = useStore((state) => state.toggleNewSession)
  const openerRef = useRef<HTMLElement | null>(document.activeElement as HTMLElement | null)

  const configuredHarness = useMemo(
    () => defaultHarnessId({ settings, harnesses } as never),
    [settings, harnesses]
  )
  const terminalOnly = newSessionPreset === 'terminal'
  const availableHarnesses = harnesses.filter((item) => item.available)
  const availableIds = new Set(availableHarnesses.map((item) => item.id))

  const [launcherMode, setLauncherMode] = useState<LauncherMode>(initialMode)
  const [repoId, setRepoId] = useState(repos[0]?.id ?? '')
  const [harness, setHarness] = useState<HarnessId | null>(terminalOnly ? null : configuredHarness)
  const [model, setModel] = useState('')
  const [role, setRole] = useState<SessionBehavior>('none')
  const [topic, setTopic] = useState('')
  const [maxTurns, setMaxTurns] = useState(DEFAULT_DEBATE_TURNS)
  const [seats, setSeats] = useState<SeatDraft[]>([
    { name: 'Advocate', harness: configuredHarness, model: '', stance: '' },
    { name: 'Sceptic', harness: configuredHarness, model: '', stance: '' }
  ])
  const [currentBranch, setCurrentBranch] = useState('')

  const sessionMode = terminalOnly || launcherMode === 'session'
  const repo = repos.find((item) => item.id === repoId) ?? null
  const sessionModelOptions = modelOptionsFor(
    harness === null ? undefined : modelCatalogues[harness],
    model
  )

  useEffect(() => {
    if (!terminalOnly) ensureModelCatalogues()
  }, [ensureModelCatalogues, terminalOnly])

  useEffect(() => {
    if (repos.length > 0 && !repos.some((item) => item.id === repoId)) setRepoId(repos[0].id)
  }, [repoId, repos])

  useEffect(() => {
    if (!repo || !sessionMode) {
      setCurrentBranch('')
      return
    }
    let cancelled = false
    window.api.currentBranch(repo.path).then((nextCurrent) => {
      if (!cancelled) setCurrentBranch(nextCurrent)
    })
    return () => {
      cancelled = true
    }
  }, [repo, sessionMode])

  useEffect(() => {
    if (terminalOnly) {
      setHarness(null)
      return
    }
    if (harness === null || !availableIds.has(harness)) {
      setHarness(configuredHarness)
      setModel('')
    }
    setSeats((current) =>
      current.map((seat) =>
        availableIds.has(seat.harness)
          ? seat
          : { ...seat, harness: configuredHarness, model: '' }
      )
    )
    // `availableIds` is derived from harnesses; depending on the source array
    // avoids re-running this effect for a newly allocated Set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configuredHarness, harnesses, terminalOnly])

  if (repos.length === 0) return <></>

  const close = (): void => {
    if (onClose) onClose()
    else toggleNewSession(false)
    openerRef.current?.focus()
  }

  const harnessAvailable = harness === null || availableIds.has(harness)
  const canLaunchSession = repo !== null && currentBranch.length > 0 && harnessAvailable && !busy
  const canStartDebate =
    repo !== null &&
    topic.trim().length > 0 &&
    seats.every((seat) => availableIds.has(seat.harness) && seat.stance.trim().length > 0) &&
    !busy

  const submitSession = async (): Promise<void> => {
    if (!repo || !canLaunchSession) return
    const branchLabel = terminalOnly
      ? 'terminal'
      : [role === 'none' ? '' : role, model || harness || 'session'].filter(Boolean).join('-')
    const branch = `conductor/${slugBranchLabel(branchLabel)}-${uniqueBranchSuffix()}`
    const agentFields =
      harness === null
        ? {}
        : {
            model: model || undefined,
            initialPrompt: applyBehaviorToPrompt(role, '') || undefined
          }

    const created = await createSession({
      repoId: repo.id,
      repoPath: repo.path,
      worktreePath: '',
      branch,
      harness,
      ...agentFields,
      createWorktree: {
        repoPath: repo.path,
        branch,
        baseBranch: currentBranch,
        newBranch: true
      }
    })
    if (!created) return
    close()
    if (harness === null) openSession(created.id)
  }

  const submitDebate = async (): Promise<void> => {
    if (!repo || !canStartDebate) return
    const trimmedTopic = topic.trim()
    const created = await createRoundtable({
      name: trimmedTopic,
      repoId: repo.id,
      repoPath: repo.path,
      topic: trimmedTopic,
      seats: seats.map((seat) => ({
        name: seat.name,
        harness: seat.harness,
        model: seat.model || null,
        stance: seat.stance.trim()
      })),
      maxTurns
    })
    if (!created) return
    close()
    await startRoundtable(created.id)
  }

  const canSubmit = sessionMode ? canLaunchSession : canStartDebate

  let subtitle: string
  if (terminalOnly) subtitle = 'Open a shell in an automatic fresh worktree'
  else if (launcherMode === 'session') subtitle = 'One model, one role, ready to work'
  else subtitle = 'Two stances, one topic, a bounded decision'

  let footerNote: string
  if (terminalOnly) footerNote = 'Repository + branch selected automatically'
  else if (launcherMode === 'session') footerNote = 'Identity: model + role'
  else footerNote = `${maxTurns} turns maximum · starts immediately`

  let submitIcon: JSX.Element
  if (busy) submitIcon = <Loader2 size={15} className="animate-spin" />
  else if (sessionMode) submitIcon = <Sparkles size={15} />
  else submitIcon = <MessageCircle size={15} />

  return (
    <div
      className="modal-scrim fixed inset-0 z-40 flex items-center justify-center p-4"
      onClick={close}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        if (!busy) close()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-launch-title"
        aria-busy={busy}
        className="glass-modal flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex shrink-0 items-center gap-3 border-b glass-divider px-5 py-3.5">
          <div className="grid h-9 w-9 place-items-center rounded-xl border border-accent/25 bg-accent/10 text-accent">
            {terminalOnly ? <AgentIcon harness={null} size={15} /> : <Sparkles size={17} />}
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="new-launch-title" className="text-sm font-semibold">
              {terminalOnly ? 'New terminal' : 'New'}
            </h2>
            <p className="font-mono text-[10px] text-text-hint">
              {subtitle}
            </p>
          </div>
          <button
            className="text-text-low transition-colors hover:text-text-hi disabled:opacity-50"
            onClick={close}
            disabled={busy}
            aria-label="Close launcher"
          >
            <X size={17} />
          </button>
        </header>

        {!terminalOnly && (
          <div className="border-b glass-divider px-5 py-3">
            <div className="glass-segment" role="tablist" aria-label="Creation type">
              <LauncherTab
                active={launcherMode === 'session'}
                onClick={() => setLauncherMode('session')}
                icon={<Sparkles size={13} />}
              >
                Session
              </LauncherTab>
              <LauncherTab
                active={launcherMode === 'debate'}
                onClick={() => setLauncherMode('debate')}
                icon={<Users size={13} />}
              >
                Debate
              </LauncherTab>
            </div>
          </div>
        )}

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
          {!sessionMode && (
            <Field label="Repository">
              <select
                className="input"
                value={repoId}
                onChange={(event) => setRepoId(event.target.value)}
                aria-label="Repository"
              >
                {repos.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} — {item.path}
                  </option>
                ))}
              </select>
            </Field>
          )}

          {sessionMode ? (
            !terminalOnly &&
            harness !== null && (
              <>
                <Field label="Model">
                  <div className="flex flex-col gap-2">
                    <div className="grid grid-cols-3 gap-2">
                      {(['claude', 'codex', 'zai'] as HarnessId[]).map((id) => {
                        const enabled = availableIds.has(id)
                        const info = agentInfo(id)
                        return (
                          <button
                            key={id}
                            type="button"
                            disabled={!enabled}
                            onClick={() => {
                              setHarness(id)
                              setModel('')
                            }}
                            aria-pressed={harness === id}
                            className={`flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors ${
                              harness === id
                                ? 'border-accent/55 bg-accent/[0.13]'
                                : 'glass-divider hover:border-white/20'
                            } ${enabled ? '' : 'cursor-not-allowed opacity-40'}`}
                          >
                            <AgentIcon harness={id} />
                            <span className="min-w-0">
                              <span className="block text-xs font-medium">{info.label}</span>
                              <span className="block truncate font-mono text-[10px] text-text-hint">{info.provider}</span>
                            </span>
                          </button>
                        )
                      })}
                    </div>
                    <select
                      className="input"
                      value={model}
                      onChange={(event) => setModel(event.target.value)}
                      aria-label="Model"
                    >
                      <option value="">Harness default</option>
                      {sessionModelOptions.values.map((option) => (
                        <option key={option} value={option}>
                          {option === sessionModelOptions.unlisted ? `${option} (unlisted)` : option}
                        </option>
                      ))}
                    </select>
                  </div>
                </Field>
                <Field label="Role">
                  <select
                    className="input"
                    value={role}
                    onChange={(event) => setRole(event.target.value as SessionBehavior)}
                    aria-label="Role preset"
                  >
                    {SESSION_BEHAVIORS.map((option) => (
                      <option key={option} value={option}>
                        {BEHAVIOR_LABELS[option]}
                      </option>
                    ))}
                  </select>
                </Field>
              </>
            )
          ) : (
            <>
              <Field label="Topic">
                <textarea
                  className="input min-h-[84px] resize-none text-sm leading-relaxed"
                  placeholder="What decision should these two models argue through?"
                  value={topic}
                  onChange={(event) => setTopic(event.target.value)}
                  aria-label="Topic"
                  autoFocus
                />
              </Field>

              <div className="grid grid-cols-2 gap-3 max-[680px]:grid-cols-1">
                {seats.map((seat, index) => (
                  <DebateSeat
                    key={seat.name}
                    index={index}
                    seat={seat}
                    availableHarnesses={availableHarnesses}
                    modelCatalogue={modelCatalogues[seat.harness]}
                    onChange={(patch) =>
                      setSeats((current) =>
                        current.map((item, seatIndex) =>
                          seatIndex === index ? { ...item, ...patch } : item
                        )
                      )
                    }
                    disabled={busy}
                  />
                ))}
              </div>

              <Field label="Max turns">
                <div className="flex items-center gap-3 rounded-xl border glass-divider bg-bg-1/40 px-3 py-2.5">
                  <span className="w-5 text-center font-mono text-sm font-semibold text-accent">{maxTurns}</span>
                  <input
                    className="min-w-0 flex-1 accent-[rgb(var(--accent))]"
                    type="range"
                    min={2}
                    max={MAX_ROUNDTABLE_TURNS}
                    step={1}
                    value={maxTurns}
                    onChange={(event) => setMaxTurns(Number(event.target.value))}
                    aria-label="Max turns"
                    disabled={busy}
                  />
                  <span className="font-mono text-[10px] text-text-hint">2–{MAX_ROUNDTABLE_TURNS}</span>
                </div>
                <span className="mt-1 font-mono text-[10px] text-text-hint">
                  Hard token-thrift stop. A conclusion may end the debate sooner.
                </span>
              </Field>
            </>
          )}

          {error && (
            <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300" role="alert">
              {error}
            </div>
          )}
        </div>

        <footer className="flex shrink-0 items-center justify-between gap-3 border-t glass-divider px-5 py-3">
          <span className="font-mono text-[10px] text-text-hint">
            {footerNote}
          </span>
          <div className="flex items-center gap-2">
            <button className="btn-ghost" onClick={close} disabled={busy}>
              Cancel
            </button>
            <button
              className="btn-primary"
              onClick={() => void (sessionMode ? submitSession() : submitDebate())}
              disabled={!canSubmit}
            >
              {submitIcon}
              {terminalOnly ? 'Launch' : sessionMode ? 'Launch session' : 'Start debate'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}


function DebateSeat({
  index,
  seat,
  availableHarnesses,
  modelCatalogue,
  onChange,
  disabled
}: {
  index: number
  seat: SeatDraft
  availableHarnesses: HarnessAvailability[]
  modelCatalogue: HarnessCatalogue
  onChange: (patch: Partial<SeatDraft>) => void
  disabled: boolean
}): JSX.Element {
  const options = modelOptionsFor(modelCatalogue, seat.model)
  const accent = agentInfo(seat.harness).accent
  const seatNumber = index + 1
  return (
    <section
      className="rounded-xl border bg-bg-1/55 p-3"
      style={{
        borderColor: `color-mix(in srgb, ${accent} 32%, transparent)`,
        boxShadow: `inset 3px 0 0 color-mix(in srgb, ${accent} 70%, transparent)`
      }}
      aria-label={`Seat ${seatNumber}`}
    >
      <div className="mb-3 flex items-center gap-2.5">
        <AgentIcon harness={seat.harness} />
        <div>
          <div className="text-xs font-semibold">{seat.name}</div>
          <div className="font-mono text-[10px] text-text-hint">Seat {seatNumber}</div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <select
          className="input"
          value={seat.harness}
          onChange={(event) => onChange({ harness: event.target.value as HarnessId, model: '' })}
          disabled={disabled || availableHarnesses.length === 0}
          aria-label={`Seat ${seatNumber} harness`}
        >
          {availableHarnesses.map((item) => (
            <option key={item.id} value={item.id}>
              {item.info.label}
            </option>
          ))}
        </select>
        <select
          className="input min-w-0"
          value={seat.model}
          onChange={(event) => onChange({ model: event.target.value })}
          disabled={disabled}
          aria-label={`Seat ${seatNumber} model`}
        >
          <option value="">Default model</option>
          {options.values.map((option) => (
            <option key={option} value={option}>
              {option === options.unlisted ? `${option} (unlisted)` : option}
            </option>
          ))}
        </select>
      </div>
      <input
        className="input mt-2"
        value={seat.stance}
        onChange={(event) => onChange({ stance: event.target.value })}
        placeholder={index === 0 ? 'Argue for the pragmatic path' : 'Challenge risk and assumptions'}
        maxLength={180}
        disabled={disabled}
        aria-label={`Seat ${seatNumber} stance`}
      />
    </section>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="label">{label}</span>
      {children}
    </div>
  )
}

function LauncherTab({
  active,
  onClick,
  icon,
  children
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  children: React.ReactNode
}): JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`flex flex-1 items-center justify-center gap-1.5 rounded px-3 py-2 text-xs font-medium transition-colors ${
        active
          ? 'bg-accent/20 text-text-hi shadow-[inset_0_0_0_1px_rgb(var(--accent)/0.38)]'
          : 'text-text-low hover:text-text-mid'
      }`}
    >
      {icon}
      {children}
    </button>
  )
}

