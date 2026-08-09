import { useState } from 'react'
import {
  ChevronDown,
  Check,
  Folder,
  FolderPlus,
  Gauge,
  Grid2x2,
  LayoutGrid,
  MessageCircle,
  Plus,
  SlidersHorizontal,
  Sparkles,
  TerminalSquare,
  Trash2
} from 'lucide-react'
import type { CanvasPanelKind } from '@shared/types'
import { useStore } from '../store/useStore'
import { HarnessStatus } from './HarnessStatus'

/**
 * The strip under the title bar: what is on the canvas, and which arrangement.
 *
 * Its empty space drags the window and double-click maximizes, because a 36px
 * title bar is a small target on a frameless window.
 */

const TOGGLES: { kind: CanvasPanelKind; label: string; icon: JSX.Element }[] = [
  { kind: 'sessions', label: 'Sessions', icon: <TerminalSquare size={12} /> },
  { kind: 'work', label: 'Work', icon: <Grid2x2 size={12} /> },
  { kind: 'fleet', label: 'Fleet', icon: <Gauge size={12} /> },
  { kind: 'settings', label: 'Settings', icon: <SlidersHorizontal size={12} /> }
]

const drag = { WebkitAppRegion: 'drag' } as React.CSSProperties
const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties

export function CanvasBar(): JSX.Element {
  const canvas = useStore((s) => s.settings.canvas)
  const repos = useStore((s) => s.repos)
  const openPanel = useStore((s) => s.openPanel)
  const closePanel = useStore((s) => s.closePanel)
  const saveLayout = useStore((s) => s.saveLayout)
  const applyLayout = useStore((s) => s.applyLayout)
  const deleteLayout = useStore((s) => s.deleteLayout)
  const resetCanvasToDefault = useStore((s) => s.resetCanvasToDefault)
  const toggleNewSession = useStore((s) => s.toggleNewSession)
  const toggleNewRoundtable = useStore((s) => s.toggleNewRoundtable)
  const openNewTerminal = useStore((s) => s.openNewTerminal)
  const toggleNewRavel = useStore((s) => s.toggleNewRavel)
  const addRepo = useStore((s) => s.addRepo)
  const removeRepo = useStore((s) => s.removeRepo)
  const harnesses = useStore((s) => s.harnesses)
  const [creationMenuOpen, setCreationMenuOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [reposMenuOpen, setReposMenuOpen] = useState(false)
  const [name, setName] = useState('')

  const openIds = new Set(canvas.panels.map((panel) => panel.id))
  const active = canvas.layouts.find((layout) => layout.id === canvas.activeLayoutId)

  const commit = (): void => {
    saveLayout(name)
    setName('')
    setMenuOpen(false)
  }

  const pickRepo = async (): Promise<void> => {
    const dir = await window.api.pickDirectory()
    if (dir) await addRepo(dir)
  }

  return (
    <div
      className="relative flex h-9 shrink-0 items-center gap-1.5 border-b border-white/[0.055] px-3"
      style={drag}
      onDoubleClick={() => void window.api.toggleMaximizeWindow()}
    >
      {TOGGLES.map(({ kind, label, icon }) => {
        const on = openIds.has(kind)
        return (
          <button
            key={kind}
            style={noDrag}
            data-testid={kind === 'settings' ? 'open-settings' : `toggle-${kind}`}
            aria-pressed={on}
            onClick={() => (on ? closePanel(kind) : openPanel(kind))}
            className={`flex h-[26px] items-center gap-1.5 rounded-lg px-3 text-[11.5px] transition-colors ${
              on
                ? 'border border-accent/[0.42] bg-accent/[0.17] text-white'
                : 'text-text-low hover:text-text-mid'
            }`}
          >
            {icon} {label}
          </button>
        )
      })}
      <div className="relative" style={noDrag} onMouseLeave={() => setCreationMenuOpen(false)}>
        <button
          type="button"
          data-testid="new-menu"
          disabled={repos.length === 0}
          title={repos.length === 0 ? 'Add a repository first' : 'Create a session or debate'}
          aria-expanded={creationMenuOpen}
          onClick={() => setCreationMenuOpen((open) => !open)}
          className="flex h-[26px] items-center gap-1.5 rounded-lg border border-accent/[0.32] bg-accent/[0.11] px-3 text-[11.5px] text-text-mid transition-colors hover:bg-accent/[0.18] hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Plus size={12} /> New <ChevronDown size={11} />
        </button>
        {creationMenuOpen && (
          <div className="glass-panel absolute left-0 top-[30px] z-50 w-48 p-1.5">
            <button
              type="button"
              className="glass-choice flex w-full items-center gap-2 px-2 py-2 text-left text-[11.5px]"
              onClick={() => {
                setCreationMenuOpen(false)
                toggleNewSession(true)
              }}
            >
              <Sparkles size={12} className="text-accent" />
              <span>
                <span className="block text-text-mid">Session</span>
                <span className="block font-mono text-[9px] text-text-hint">Model + role</span>
              </span>
            </button>
            <button
              type="button"
              className="glass-choice mt-0.5 flex w-full items-center gap-2 px-2 py-2 text-left text-[11.5px]"
              onClick={() => {
                setCreationMenuOpen(false)
                toggleNewRoundtable(true)
              }}
            >
              <MessageCircle size={12} className="text-cyan-300" />
              <span>
                <span className="block text-text-mid">Debate</span>
                <span className="block font-mono text-[9px] text-text-hint">Two live seats</span>
              </span>
            </button>
          </div>
        )}
      </div>

      <button
        type="button"
        style={noDrag}
        data-testid="new-terminal"
        disabled={repos.length === 0}
        title={repos.length === 0 ? 'Add a repository first' : 'New plain terminal'}
        onClick={openNewTerminal}
        className="flex h-[26px] items-center gap-1.5 rounded-lg px-3 text-[11.5px] text-text-low hover:text-text-mid disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Plus size={12} /> Terminal
      </button>
      <button
        type="button"
        style={noDrag}
        data-testid="new-ravel"
        disabled={repos.length === 0}
        title={repos.length === 0 ? 'Add a repository first' : 'New Ravel orchestrator'}
        onClick={() => toggleNewRavel(true)}
        className="flex h-[26px] items-center gap-1.5 rounded-lg px-3 text-[11.5px] text-text-low hover:text-text-mid disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Sparkles size={12} /> Ravel
      </button>

      <div className="relative" style={noDrag}>
        <button
          type="button"
          style={noDrag}
          onClick={() => setReposMenuOpen((open) => !open)}
          data-testid="repos-menu"
          aria-expanded={reposMenuOpen}
          className="flex h-[26px] items-center gap-1.5 rounded-lg px-3 text-[11.5px] text-text-low hover:text-text-mid"
        >
          <Folder size={12} /> Repositories · {repos.length}
        </button>

        {reposMenuOpen && (
          <div
            className="glass-panel absolute left-0 top-[30px] z-50 w-72 p-1.5"
            onMouseLeave={() => setReposMenuOpen(false)}
          >
            {repos.length === 0 ? (
              <p className="px-2 py-2 text-[11px] text-text-low">
                No repositories yet — add one to begin.
              </p>
            ) : (
              repos.map((repo) => (
                <div key={repo.id} className="flex items-center gap-1">
                  <span className="glass-choice flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-[11.5px]">
                    <Folder size={11} className="shrink-0 text-accent" />
                    <span className="min-w-0 flex-1 truncate" title={repo.path}>
                      {repo.name}
                    </span>
                  </span>
                  <button
                    onClick={() => void removeRepo(repo.id)}
                    aria-label={`Remove ${repo.name}`}
                    className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-md text-text-low hover:bg-red-500/20 hover:text-text-hi"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              ))
            )}

            <div className="mt-1.5 border-t glass-divider pt-1.5">
              <button
                type="button"
                data-testid="add-repository-menu"
                onClick={pickRepo}
                className="glass-choice flex w-full items-center gap-2 px-2 py-1.5 text-left text-[11.5px]"
              >
                <FolderPlus size={11} className="text-accent" />
                Add repository…
              </button>
            </div>

            <div className="mt-1.5 border-t glass-divider pt-1.5">
              <HarnessStatus harnesses={harnesses} />
            </div>
          </div>
        )}
      </div>
      <div className="relative ml-auto" style={noDrag}>
        <button
          onClick={() => setMenuOpen((open) => !open)}
          data-testid="layouts-menu"
          aria-expanded={menuOpen}
          className="flex h-[26px] items-center gap-1.5 rounded-lg px-3 text-[11.5px] text-text-low hover:text-text-mid"
        >
          <LayoutGrid size={12} /> {active?.name ?? 'Layouts'}
        </button>

        {menuOpen && (
          <div
            className="glass-panel absolute right-0 top-[30px] z-50 w-60 p-1.5"
            onMouseLeave={() => setMenuOpen(false)}
          >
            <button
              type="button"
              data-testid="reset-command-centre"
              onClick={() => {
                resetCanvasToDefault()
                setMenuOpen(false)
              }}
              className="glass-choice mb-1 flex w-full items-center gap-2 px-2 py-1.5 text-left text-[11.5px]"
            >
              <LayoutGrid size={11} className="text-accent" />
              Reset to Command Centre
            </button>
            {canvas.layouts.length === 0 && (
              <p className="px-2 py-2 text-[11px] text-text-low">
                No saved layouts. Arrange the canvas, then name it below.
              </p>
            )}
            {canvas.layouts.map((layout) => (
              <div key={layout.id} className="flex items-center gap-1">
                <button
                  onClick={() => {
                    applyLayout(layout.id)
                    setMenuOpen(false)
                  }}
                  data-testid="layout-entry"
                  className="glass-choice flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-[11.5px]"
                >
                  {layout.id === canvas.activeLayoutId ? (
                    <Check size={11} className="shrink-0 text-accent" />
                  ) : (
                    <span className="w-[11px] shrink-0" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{layout.name}</span>
                  <span className="shrink-0 font-mono text-[9px] text-text-hint">
                    {layout.panels.length}
                  </span>
                </button>
                <button
                  onClick={() => deleteLayout(layout.id)}
                  aria-label={`Delete ${layout.name}`}
                  className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-md text-text-low hover:bg-red-500/20 hover:text-text-hi"
                >
                  <Trash2 size={11} />
                </button>
              </div>
            ))}

            <div className="mt-1.5 flex items-center gap-1 border-t glass-divider pt-1.5">
              <input
                className="glass-input h-[28px] min-h-0 flex-1 px-2 text-[11.5px]"
                placeholder="Save current as…"
                value={name}
                data-testid="layout-name"
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') commit()
                }}
              />
              <button
                onClick={commit}
                disabled={name.trim().length === 0}
                data-testid="layout-save"
                className="btn-primary h-[28px] px-2.5 text-[11.5px] disabled:opacity-40"
              >
                Save
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
