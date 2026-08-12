import React, { useEffect, useState } from 'react'
import { useStore } from '../store/useStore'
import {
  composeModel,
  harnessSupportsBehavior,
  splitModel,
  modelOptionsFor,
  THINKING_LEVELS,
  ACRYLIC_INTENSITY_MAX,
  ACRYLIC_INTENSITY_MIN,
  CONDUCTOR_THEMES,
  orderPanels,
  panelDock,
  PANEL_LABELS,
  RAIL_PANEL_IDS,
  HARNESS_INFO,
  THEME_LABELS
} from '@shared/types'
import type { HarnessId, Settings, ThinkingLevel } from '@shared/types'
import { Save, RotateCcw, FolderOpen, Check, RefreshCw, Download, RotateCw } from 'lucide-react'
import { HarnessBadge } from './HarnessBadge'
import { RemoteAccessSection } from './RemoteAccessSection'

const HARNESS_IDS: HarnessId[] = ['claude', 'codex', 'zai']
type UpdaterStatus = Awaited<ReturnType<Window['api']['updaterStatus']>>

export function SettingsView(): JSX.Element {
  const settings = useStore((s) => s.settings)
  const harnesses = useStore((s) => s.harnesses)
  const modelCatalogues = useStore((s) => s.modelCatalogues)
  const ensureModelCatalogues = useStore((s) => s.ensureModelCatalogues)
  const repos = useStore((s) => s.repos)
  const saveSettings = useStore((s) => s.saveSettings)
  const refreshHarnesses = useStore((s) => s.refreshHarnesses)

  const [draft, setDraft] = useState<Settings>(settings)
  const [saved, setSaved] = useState(false)
  const [repoId, setRepoId] = useState(repos[0]?.id ?? '')
  const [updaterStatus, setUpdaterStatus] = useState<UpdaterStatus>({ state: 'idle' })

  useEffect(() => {
    let mounted = true
    const unsubscribe = window.api.onUpdaterStatus((status) => {
      if (mounted) setUpdaterStatus(status)
    })
    void window.api.updaterStatus().then((status) => {
      if (mounted) setUpdaterStatus(status)
    })
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [])

  const updateStatus = async (action: () => Promise<UpdaterStatus>): Promise<void> => {
    try {
      setUpdaterStatus(await action())
    } catch (error) {
      setUpdaterStatus({
        state: 'error',
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  // Live model lists cost a CLI spawn each, so they are fetched when a
  // dropdown that shows them actually appears — not at app startup.
  useEffect(() => {
    ensureModelCatalogues()
  }, [ensureModelCatalogues])

  useEffect(() => setDraft(settings), [settings])

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings)

  const patch = (p: Partial<Settings>): void => {
    setDraft((d) => ({ ...d, ...p }))
    setSaved(false)
  }

  const save = async (): Promise<void> => {
    await saveSettings(draft)
    await refreshHarnesses()
    setSaved(true)
  }

  const pickRoot = async (): Promise<void> => {
    const p = await window.api.pickDirectory()
    if (p) patch({ worktreeRoot: p })
  }

  return (
    <div data-testid="settings-view" className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-6 py-6">
        <Section title="Appearance" desc="How Conductor paints its chrome and surfaces. Applies immediately on save.">
          <Row label="Theme">
            <div className="glass-segment">
              {CONDUCTOR_THEMES.map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => patch({ theme: id })}
                  aria-pressed={draft.theme === id}
                  className="glass-segment__button"
                >
                  {THEME_LABELS[id]}
                </button>
              ))}
            </div>
            <Hint>
              {draft.theme === 'terminal'
                ? 'Green-on-black palette mirroring the omp dark-terminal theme.'
                : 'Conductor dark with amber accents.'}
            </Hint>
          </Row>
          <Row label="Acrylic">
            <label className="flex items-center gap-2 text-sm text-text-mid">
              <input
                type="checkbox"
                className="h-4 w-4 accent-[rgb(var(--accent))]"
                checked={draft.acrylic}
                onChange={(e) => patch({ acrylic: e.target.checked })}
              />
              Translucent glass surfaces
            </label>
            <Hint>Translucent plates that blur what sits behind them. Combines with either palette.</Hint>
          </Row>
          <Row label="Acrylic intensity">
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={ACRYLIC_INTENSITY_MIN}
                max={ACRYLIC_INTENSITY_MAX}
                step={5}
                value={draft.acrylicIntensity}
                disabled={!draft.acrylic}
                onChange={(e) => patch({ acrylicIntensity: Number(e.target.value) })}
                className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-[var(--glass-inset-bg)] accent-[rgb(var(--accent))] disabled:cursor-not-allowed disabled:opacity-40"
                aria-label="Acrylic intensity"
              />
              <span className="w-10 text-right font-mono text-[11px] text-text-mid">{draft.acrylicIntensity}%</span>
            </div>
            <Hint>
              {draft.acrylic
                ? 'Drives plate opacity, blur radius, tint and grain together. 0 is nearly solid, 100 is maximum glass.'
                : 'Enable translucent surfaces to adjust intensity.'}
            </Hint>
          </Row>
        </Section>
        <Section title="Sign-in" desc="Choose whether Conductor starts its background Core when you sign in to Windows.">
          <label className="flex cursor-pointer items-start gap-2.5">
            <input
              type="checkbox"
              data-testid="autostart-toggle"
              checked={draft.autostart}
              onChange={(e) => patch({ autostart: e.target.checked })}
              className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
            />
            <span className="text-[12px] leading-relaxed text-text-mid">
              <span className="text-text-hi">Start Conductor at sign-in.</span> Registers a per-user Windows
              Run entry that launches a background Core at login.
            </span>
          </label>
        </Section>


        <Section title="Layout" desc="Panel widths and tab order, dragged in place and kept here.">
          <Row label="Ravel rail panels">
            <div className="flex flex-wrap items-center gap-1.5">
              {orderPanels(RAIL_PANEL_IDS, draft.panelOrder).map((id, index) => (
                <button
                  key={id}
                  className="glass-pill font-mono"
                  title={`Move ${PANEL_LABELS[id]} to the ${panelDock(draft.panelDock, id) === 'left' ? 'right' : 'left'} rail`}
                  onClick={() =>
                    patch({
                      panelDock: {
                        ...draft.panelDock,
                        [id]: panelDock(draft.panelDock, id) === 'left' ? 'right' : 'left'
                      }
                    })
                  }
                >
                  {index + 1}. {PANEL_LABELS[id]}
                  <span className="ml-1 text-text-hint">
                    {panelDock(draft.panelDock, id) === 'left' ? '◀ left' : 'right ▶'}
                  </span>
                </button>
              ))}
              <button
                className="btn-outline ml-auto shrink-0"
                onClick={() => patch({ panelOrder: [], panelDock: {} })}
                disabled={draft.panelOrder.length === 0 && Object.keys(draft.panelDock).length === 0}
              >
                <RotateCcw size={14} /> Reset layout
              </button>
            </div>
            <Hint>
              Drag a tab onto the other rail to dock it there and watch two panels at once, or press Alt+Shift+Left
              while it has focus. Alt+Left / Alt+Right reorders within a rail. Widths are dragged from the seam.
            </Hint>
          </Row>
        </Section>

        <Section title="Agent defaults" desc="Choose the default harness for new sessions.">
          <Row label="Default harness">
            <select
              className="glass-input"
              value={draft.defaultHarness}
              onChange={(e) => patch({ defaultHarness: e.target.value as HarnessId })}
            >
              {HARNESS_IDS.map((id) => {
                const h = harnesses.find((x) => x.id === id)
                return (
                  <option key={id} value={id} disabled={!h?.available}>
                    {HARNESS_INFO[id].label} {!h?.available ? '(not installed)' : ''}
                  </option>
                )
              })}
            </select>
          </Row>
          <Row label="Fall back to another AI when one runs dry">
            <input
              type="checkbox"
              className="h-4 w-4 accent-accent"
              data-testid="harness-fallback-toggle"
              checked={draft.harnessFallback.length > 0}
              onChange={(e) =>
                patch({ harnessFallback: e.target.checked ? [...HARNESS_IDS] : [] })
              }
            />
            <Hint>
              If a Ravel manager's AI hits a quota, rate limit, auth error, or isn't installed,
              automatically re-point it to the next installed AI instead of stalling. Only the
              manager switches — running child sessions are never moved.
            </Hint>
          </Row>
        </Section>

        <Section
          title="Harness models"
          desc="Default model per harness, and how hard it thinks. Ravel and individual sessions can still override."
        >
          {HARNESS_IDS.map((id) => {
            const parts = splitModel(draft.harnessModels[id])
            const catalogue = modelCatalogues[id]
            const options = modelOptionsFor(catalogue, parts.model)
            const setModel = (model: string, behavior: ThinkingLevel): void => {
              const composed = composeModel(model, behavior)
              patch({ harnessModels: { ...draft.harnessModels, [id]: composed || undefined } })
            }
            return (
              <Row key={id} label={HARNESS_INFO[id].label}>
                <div className="flex items-center gap-2">
                  <HarnessBadge id={id} />
                  <select
                    className="glass-input flex-1"
                    value={parts.model}
                    onChange={(e) => setModel(e.target.value, parts.behavior)}
                    aria-label={`${HARNESS_INFO[id].label} model`}
                  >
                    <option value="">(harness default)</option>
                    {options.values.map((model) => (
                      <option key={model} value={model}>
                        {model === options.unlisted ? `${model} (unlisted)` : model}
                      </option>
                    ))}
                  </select>
                  {harnessSupportsBehavior(id) && (
                    <select
                      className="glass-input w-32"
                      value={parts.behavior}
                      disabled={parts.model.length === 0}
                      onChange={(e) => setModel(parts.model, e.target.value as ThinkingLevel)}
                      aria-label={`${HARNESS_INFO[id].label} reasoning`}
                    >
                      {THINKING_LEVELS.map((level) => (
                        <option key={level} value={level}>
                          {level}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
                <Hint>
                  {harnessSupportsBehavior(id) ? 'Sent as --model <model>:<behavior>' : 'Sent as --model <value>'}
                  {' · '}
                  {catalogue.discovered
                    ? `${catalogue.models.length} models reported by the installed CLI.`
                    : 'Built-in fallback list — no live catalogue from this CLI.'}
                  {options.unlisted !== null &&
                    ` Saved model "${options.unlisted}" is not in that list; it stays selected and will still be sent.`}
                </Hint>
              </Row>
            )
          })}
        </Section>

        <Section title="Budget" desc="Estimated-token ceiling per ravel. Crossing it pauses the ravel.">
          <Row label="Token ceiling per ravel">
            <input
              className="glass-input font-mono"
              type="number"
              min={0}
              step={10000}
              value={draft.tokenCeilingPerRavel}
              data-testid="token-ceiling"
              onChange={(e) => patch({ tokenCeilingPerRavel: Number(e.target.value) || 0 })}
            />
            <Hint>0 disables the limit. Counts are estimated from character volume, not reported by the provider.</Hint>
          </Row>
        </Section>

        <Section title="Harness binaries" desc="Override the CLI path for each harness. Leave blank to auto-detect from PATH.">
          {HARNESS_IDS.map((id) => {
            const h = harnesses.find((x) => x.id === id)
            return (
              <Row key={id} label={HARNESS_INFO[id].label}>
                <div className="flex items-center gap-2">
                <HarnessBadge id={id} />
                <input
                  className="glass-input font-mono"
                  placeholder={h?.resolved?.resolvedFrom ?? `(auto) ${id === 'zai' ? 'omp' : id}`}
                  value={draft.harnessPaths[id] ?? ''}
                  onChange={(e) =>
                    patch({ harnessPaths: { ...draft.harnessPaths, [id]: e.target.value || undefined } })
                  }
                />
                </div>
                <Hint>
                  {h?.available ? (
                    <span className="text-success">found: {h.resolved?.resolvedFrom}</span>
                  ) : (
                    <span className="text-red-400">{h?.reason ?? 'not found'}</span>
                  )}
                </Hint>
              </Row>
            )
          })}
        </Section>

        <Section title="Worktrees" desc="Where Conductor creates isolated worktrees for each session.">
          <Row label="Worktree root">
            <div className="flex gap-2">
              <input
                className="glass-input font-mono"
                value={draft.worktreeRoot ?? ''}
                onChange={(e) => patch({ worktreeRoot: e.target.value || null })}
                placeholder="~/.conductor/worktrees (default)"
              />
              <button className="btn-outline shrink-0" onClick={pickRoot}>
                <FolderOpen size={14} /> Browse
              </button>
            </div>
          </Row>
        </Section>

        <Section
          title="Shell execution consent"
          desc="Post-create hooks and verify commands are arbitrary shell run at your full user privilege inside a worktree, which is not a sandbox. They are skipped until you turn this on."
        >
          <label className="flex cursor-pointer items-start gap-2.5">
            <input
              type="checkbox"
              data-testid="shell-consent-toggle"
              checked={draft.shellHooksConsented}
              onChange={(e) => patch({ shellHooksConsented: e.target.checked })}
              className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
            />
            <span className="text-[12px] leading-relaxed text-text-mid">
              <span className="text-text-hi">Allow hooks and verify commands to run shell.</span> Until
              enabled, post-create hooks do not run and any configured verify command is reported as a
              not-run (failed) verification so nothing lands unchecked.
            </span>
          </label>
        </Section>

        <Section title="Post-create hook (global)" desc="Runs after every new worktree. Env: WORKTREE_PATH, REPO_PATH, BRANCH. Uses bash (Git for Windows) if available.">
          <textarea
            className="glass-input min-h-[110px] resize-y font-mono text-[12px]"
            placeholder={'# e.g.\nif [ -f "$REPO_PATH/.env" ]; then\n  cp "$REPO_PATH/.env" "$WORKTREE_PATH/.env"\nfi\n[ -f pnpm-lock.yaml ] && pnpm install'}
            value={draft.hooks.global ?? ''}
            onChange={(e) => patch({ hooks: { ...draft.hooks, global: e.target.value || null } })}
          />
        </Section>

        {repos.length > 0 && (
          <Section title="Post-create hook (per-repo)" desc="Overrides the global hook for the selected repo.">
            <Row label="Repository">
              <select className="glass-input" value={repoId} onChange={(e) => setRepoId(e.target.value)}>
                {repos.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </Row>
            <textarea
              className="glass-input min-h-[110px] resize-y font-mono text-[12px]"
              placeholder="# per-repo hook (bash)"
              value={draft.hooks.perRepo[repoId] ?? ''}
              onChange={(e) => {
                const next = { ...draft.hooks.perRepo }
                const v = e.target.value
                if (v) next[repoId] = v
                else delete next[repoId]
                patch({ hooks: { ...draft.hooks, perRepo: next } })
              }}
            />
          </Section>
        )}

        <Section
          title="Verify command (global)"
          desc="Runs in a child's worktree when it finishes, before the orchestrator is told. Its verdict is what the orchestrator acts on, not the child's own summary. Same env as hooks: WORKTREE_PATH, REPO_PATH, BRANCH."
        >
          <textarea
            className="glass-input min-h-[80px] resize-y font-mono text-[12px]"
            placeholder={'# e.g.\nnpm run typecheck && npm test'}
            value={draft.verify.global ?? ''}
            onChange={(e) => patch({ verify: { ...draft.verify, global: e.target.value || null } })}
          />
        </Section>

        {repos.length > 0 && (
          <Section title="Verify command (per-repo)" desc="Replaces the global verify command for the selected repo.">
            <Row label="Repository">
              <select className="glass-input" value={repoId} onChange={(e) => setRepoId(e.target.value)}>
                {repos.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </Row>
            <textarea
              className="glass-input min-h-[80px] resize-y font-mono text-[12px]"
              placeholder="# per-repo verify command"
              value={draft.verify.perRepo[repoId] ?? ''}
              onChange={(e) => {
                const next = { ...draft.verify.perRepo }
                const v = e.target.value
                if (v) next[repoId] = v
                else delete next[repoId]
                patch({ verify: { ...draft.verify, perRepo: next } })
              }}
            />
          </Section>
        )}

        <Section title="Code editor" desc="Monaco editor preferences.">
          <Row label="Font family">
            <input
              className="glass-input font-mono"
              value={draft.editor.fontFamily}
              onChange={(e) => patch({ editor: { ...draft.editor, fontFamily: e.target.value } })}
              placeholder="'IBM Plex Mono', Menlo, Consolas, monospace"
            />
          </Row>
          <Row label="Font size">
            <input
              className="glass-input font-mono"
              type="number"
              min={8}
              max={32}
              value={draft.editor.fontSize}
              onChange={(e) =>
                patch({ editor: { ...draft.editor, fontSize: Number(e.target.value) || 13 } })
              }
            />
          </Row>
          <Row label="Word wrap">
            <input
              type="checkbox"
              className="h-4 w-4 accent-accent"
              checked={draft.editor.wordWrap}
              onChange={(e) => patch({ editor: { ...draft.editor, wordWrap: e.target.checked } })}
            />
          </Row>
          <Row label="Minimap">
            <input
              type="checkbox"
              className="h-4 w-4 accent-accent"
              checked={draft.editor.minimap}
              onChange={(e) => patch({ editor: { ...draft.editor, minimap: e.target.checked } })}
            />
          </Row>
          <Row label="Ctrl+Click go-to-definition">
            <input
              type="checkbox"
              className="h-4 w-4 accent-accent"
              checked={draft.editor.gotoDefinition}
              onChange={(e) =>
                patch({ editor: { ...draft.editor, gotoDefinition: e.target.checked } })
              }
            />
            <Hint>Same-file jumps (JS/TS/Python/Ruby/Go/Swift/Rust).</Hint>
          </Row>
        </Section>

        <Section title="Updates" desc="Check GitHub Releases manually. Reigen never downloads or installs updates automatically.">
          <Row label="Release status">
            <div className="flex flex-wrap items-center gap-2">
              {updaterStatus.state === 'available' ? (
                <button
                  className="btn-primary"
                  data-testid="download-update"
                  onClick={() => updateStatus(() => window.api.downloadUpdate())}
                >
                  <Download size={14} /> Download update
                </button>
              ) : updaterStatus.state === 'downloaded' ? (
                <button
                  className="btn-primary"
                  data-testid="install-update"
                  onClick={() => {
                    if (
                      window.confirm(
                        'Restart Reigen and install the downloaded update? Any running sessions will be interrupted.'
                      )
                    ) {
                      void updateStatus(() => window.api.installUpdate(true))
                    }
                  }}
                >
                  <RotateCw size={14} /> Restart and install
                </button>
              ) : (
                <button
                  className="btn-outline"
                  data-testid="check-for-updates"
                  disabled={updaterStatus.state === 'checking' || updaterStatus.state === 'downloading'}
                  onClick={() => updateStatus(() => window.api.checkForUpdates())}
                >
                  <RefreshCw size={14} /> Check for updates
                </button>
              )}
              <span className="font-mono text-[10px] text-text-mid">
                {updaterStatus.state === 'not-available'
                  ? 'Reigen is up to date.'
                  : updaterStatus.state === 'unsupported'
                    ? 'Updates require a packaged build.'
                    : updaterStatus.state === 'error'
                      ? updaterStatus.error ?? 'Update failed.'
                      : updaterStatus.state === 'available'
                        ? `Version ${updaterStatus.version ?? 'new'} is available.`
                        : updaterStatus.state === 'downloaded'
                          ? `Version ${updaterStatus.version ?? 'new'} is ready.`
                          : updaterStatus.state === 'downloading'
                            ? `Downloading ${Math.round(updaterStatus.percent ?? 0)}%.`
                            : updaterStatus.state === 'checking'
                              ? 'Checking GitHub Releases…'
                              : 'Manual update checks only.'}
              </span>
            </div>
          </Row>
        </Section>
        <Section title="Remote access" desc="Pair the Conductor phone app with this core over your LAN.">
          <RemoteAccessSection />
        </Section>

        <div className="glass-bar glass-bar--raised sticky bottom-0 -mx-6 mt-6 flex items-center justify-end gap-2 border-t px-6 py-3">
          <button className="btn-ghost" onClick={() => setDraft(settings)} disabled={!dirty}>
            <RotateCcw size={14} /> Revert
          </button>
          <button className="btn-primary" data-testid="settings-save" onClick={save} disabled={!dirty && !saved}>
            {saved ? <Check size={15} /> : <Save size={15} />}
            {saved ? 'Saved' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Section({
  title,
  desc,
  children
}: {
  title: string
  desc?: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <section className="glass-panel mb-4 p-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      {desc && <p className="mt-1 text-xs text-text-low">{desc}</p>}
      <div className="mt-3 flex flex-col gap-3">{children}</div>
    </section>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="label">{label}</span>
      {children}
    </div>
  )
}

function Hint({ children }: { children: React.ReactNode }): JSX.Element {
  return <p className="font-mono text-[10px] text-text-hint">{children}</p>
}
