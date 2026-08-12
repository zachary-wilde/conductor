import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useStore, defaultHarnessId } from '../store/useStore'
import type { HarnessId, ThinkingLevel } from '@shared/types'
import {
  composeModel,
  harnessSupportsBehavior,
  HARNESS_INFO,
  modelOptionsFor,
  THINKING_LEVELS
} from '@shared/types'
import { X, Loader2, Sparkles } from 'lucide-react'
import { HarnessBadge } from './HarnessBadge'


export function NewRavelModal(): JSX.Element {
  const repos = useStore((s) => s.repos)
  const harnesses = useStore((s) => s.harnesses)
  const modelCatalogues = useStore((s) => s.modelCatalogues)
  const ensureModelCatalogues = useStore((s) => s.ensureModelCatalogues)
  const settings = useStore((s) => s.settings)
  const createRavel = useStore((s) => s.createRavel)
  const openRavel = useStore((s) => s.openRavel)
  const busy = useStore((s) => s.busy)
  const error = useStore((s) => s.error)
  const toggle = useStore((s) => s.toggleNewRavel)
  const openerRef = useRef<HTMLElement | null>(document.activeElement as HTMLElement | null)

  const initialHarness = useMemo(() => defaultHarnessId({ settings, harnesses } as never), [settings, harnesses])

  const [repoId, setRepoId] = useState(repos[0]?.id ?? '')
  const [harness, setHarness] = useState<HarnessId>(initialHarness)
  const [initialInstruction, setInitialInstruction] = useState('')
  const [model, setModel] = useState('')
  const [behavior, setBehavior] = useState<ThinkingLevel>('auto')
  const [allowRisky, setAllowRisky] = useState(false)

  const available = harnesses.filter((h) => h.available)
  const repo = repos.find((r) => r.id === repoId) ?? null
  const harnessAvailable = available.some((h) => h.id === harness)
  const modelOptions = modelOptionsFor(modelCatalogues[harness], model)
  const canSubmit = !!repo && harnessAvailable && !busy

  // Live model lists cost a CLI spawn each, so they are fetched when a
  // dropdown that shows them actually appears — not at app startup.
  useEffect(() => {
    ensureModelCatalogues()
  }, [ensureModelCatalogues])

  useEffect(() => {
    if (repos.length > 0 && !repos.some((repo) => repo.id === repoId)) setRepoId(repos[0].id)
  }, [repoId, repos])

  useEffect(() => {
    if (!harnessAvailable) setHarness(initialHarness)
  }, [harnessAvailable, initialHarness])

  const close = (): void => {
    toggle(false)
    openerRef.current?.focus()
  }

  const submit = async (): Promise<void> => {
    if (!repo || !canSubmit) return
    const cfg = await createRavel({
      repoId: repo.id,
      repoPath: repo.path,
      harness,
      model: composeModel(model, behavior) || undefined,
      initialInstruction: initialInstruction.trim() || undefined,
      allowRisky
    })
    if (cfg) openRavel(cfg.id)
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4 backdrop-blur-md"
      onClick={close}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.preventDefault()
        e.stopPropagation()
        if (!busy) close()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-ravel-title"
        aria-busy={busy}
        className="card flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative flex items-center gap-3 border-b glass-divider px-5 py-4">
          <div className="pointer-events-none absolute left-5 right-12 top-0 h-px bg-gradient-to-r from-accent/70 via-cyan-300/40 to-transparent" />
          <div className="flex h-8 w-8 items-center justify-center rounded-md border border-accent/25 bg-accent/10 text-accent shadow-[0_0_24px_rgba(255,149,0,0.08)]">
            <Sparkles size={17} />
          </div>
          <div className="min-w-0 flex-1">
            <div id="new-ravel-title" className="text-sm font-semibold">
              New Reigen
            </div>
            <div className="font-mono text-[10px] text-text-hint">
              A conversational orchestrator that plans before dispatching specialist sessions
            </div>
          </div>
          <button className="text-text-low hover:text-text-hi disabled:opacity-50" onClick={close} disabled={busy} aria-label="Close New Reigen">
            <X size={18} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
          {repos.length === 0 && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200" role="alert">
              No repositories are configured. Add a repository before creating Reigen.
            </div>
          )}

          <Field label="Repository">
            <select className="input" value={repoId} onChange={(e) => setRepoId(e.target.value)} disabled={busy || repos.length === 0}>
              {repos.map((repo) => (
                <option key={repo.id} value={repo.id}>
                  {repo.name}
                </option>
              ))}
            </select>
            {repos.length > 0 && !repo && (
              <div className="mt-1 font-mono text-[10px] text-red-300" role="alert">
                Selected repository is unavailable. Choose another repository.
              </div>
            )}
          </Field>

          <Field label="Reigen harness">
            <div className="flex flex-wrap gap-2">
              {available.length === 0 && (
                <span className="font-mono text-[11px] text-text-hint" role="alert">
                  No harnesses detected — configure in Settings.
                </span>
              )}
              {available.map((item) => {
                const active = harness === item.id
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setHarness(item.id)}
                    disabled={busy}
                    aria-pressed={active}
                    className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm transition-colors disabled:opacity-50 ${
                      active ? 'border-accent bg-accent/10 text-text-hi' : 'border-edge text-text-mid hover:bg-bg-2'
                    }`}
                  >
                    <HarnessBadge id={item.id} size={18} />
                    {HARNESS_INFO[item.id].label}
                  </button>
                )
              })}
            </div>
          </Field>

          <Field label="Reigen model">
            <div className="flex items-center gap-2">
              <select
                className="input flex-1"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                disabled={busy}
                aria-label="Reigen model"
              >
                <option value="">(harness default)</option>
                {modelOptions.values.map((option) => (
                  <option key={option} value={option}>
                    {option === modelOptions.unlisted ? `${option} (unlisted)` : option}
                  </option>
                ))}
              </select>
              {harnessSupportsBehavior(harness) && (
                <select
                  className="input w-32"
                  value={behavior}
                  disabled={busy || model.length === 0}
                  onChange={(e) => setBehavior(e.target.value as ThinkingLevel)}
                  aria-label="Reigen reasoning"
                >
                  {THINKING_LEVELS.map((level) => (
                    <option key={level} value={level}>
                      {level}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </Field>

          <Field label="Initial instruction">
            <textarea
              className="input h-40 resize-none font-mono text-[12px] leading-relaxed"
              placeholder={
                'Tell Reigen what outcome to plan for. Include constraints, files, acceptance criteria, and anything that should stay untouched.'
              }
              value={initialInstruction}
              onChange={(e) => setInitialInstruction(e.target.value)}
              maxLength={16000}
              disabled={busy}
            />
            <div className="mt-1 font-mono text-[10px] text-text-hint">
              {initialInstruction.trim().length === 0
                ? 'Without an initial instruction, Reigen starts idle with the composer ready.'
                : `${initialInstruction.length} chars · Reigen will compile a plan for approval before launching children`}
            </div>
          </Field>


          <Field label="Autonomy">
            <label className="flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                data-testid="ravel-allow-risky"
                checked={allowRisky}
                disabled={busy}
                onChange={(e) => setAllowRisky(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
              />
              <span className="text-[12px] leading-relaxed text-text-mid">
                <span className="text-text-hi">Auto-approve child tool calls</span> — lets Ravel children
                run every file edit and shell command at your full user privilege without prompting
                (Claude&apos;s <code className="font-mono text-[11px]">--dangerously-skip-permissions</code>).
                The child works in a git worktree, which is <span className="text-text-hi">not a sandbox</span>.
                Leave off unless you trust this run to act unattended.
              </span>
            </label>
          </Field>

          {error && (
            <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300" role="alert">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t glass-divider px-5 py-3">
          <button className="btn-ghost" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button className="btn-primary" disabled={!canSubmit} onClick={submit} aria-busy={busy}>
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
            Create Reigen
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="label">{label}</span>
      {children}
    </label>
  )
}
