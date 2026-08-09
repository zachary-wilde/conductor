import { useStore } from '../store/useStore'
import { HARNESS_INFO } from '@shared/types'
import { Plus, FolderPlus, Settings as SettingsIcon, Github, X, Boxes } from 'lucide-react'

/**
 * Left rail: repositories, new-session trigger, harness availability, settings.
 * Renders a full labelled column, or (when `compact`) a 56px icon strip for
 * narrower viewports — see `.workspace-shell` breakpoints in index.css.
 */
export function ProjectRail({ compact }: { compact: boolean }): JSX.Element {
  const repos = useStore((s) => s.repos)
  const harnesses = useStore((s) => s.harnesses)
  const addRepo = useStore((s) => s.addRepo)
  const removeRepo = useStore((s) => s.removeRepo)
  const toggleNewSession = useStore((s) => s.toggleNewSession)
  const openSettings = useStore((s) => s.openSettings)
  const view = useStore((s) => s.view)

  const onAddRepo = async (): Promise<void> => {
    const p = await window.api.pickDirectory()
    if (p) await addRepo(p)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Brand */}
      <div className={`flex items-center gap-2.5 py-4 ${compact ? 'justify-center px-0' : 'px-4'}`}>
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent text-black">
          <Boxes size={16} strokeWidth={2.5} />
        </div>
        {!compact && (
          <div className="leading-tight">
            <div className="text-sm font-semibold tracking-tight">Conductor</div>
            <div className="font-mono text-[10px] text-text-hint">parallel agents</div>
          </div>
        )}
      </div>

      {/* New session */}
      <div className={`pb-2 ${compact ? 'flex justify-center px-0' : 'px-3'}`}>
        <button
          className={compact ? 'btn-primary h-9 w-9 p-0' : 'btn-primary w-full'}
          onClick={() => toggleNewSession(true)}
          disabled={repos.length === 0}
          title={repos.length === 0 ? 'Add a repository first' : 'New session (Ctrl+N)'}
        >
          <Plus size={15} />
          {!compact && 'Session'}
        </button>
      </div>

      {/* Repos */}
      <div className={`mt-2 flex min-h-0 flex-1 flex-col ${compact ? 'items-center px-0' : 'px-2'}`}>
        <div className={`flex items-center py-1.5 ${compact ? 'justify-center' : 'justify-between px-2'}`}>
          {!compact && <span className="label">Repositories</span>}
          <button
            className="text-text-low hover:text-text-hi"
            onClick={onAddRepo}
            title="Add repository"
          >
            <FolderPlus size={14} />
          </button>
        </div>
        <div className="min-h-0 w-full flex-1 overflow-y-auto overflow-x-hidden">
          {repos.length === 0 ? (
            compact ? (
              <button
                onClick={onAddRepo}
                className="glass-choice mx-auto flex h-9 w-9 items-center justify-center border-dashed text-text-low hover:text-text-mid"
                title="Add a git repository"
              >
                <Github size={14} />
              </button>
            ) : (
              <button
                onClick={onAddRepo}
                className="glass-choice mx-1 flex w-[calc(100%-8px)] items-center gap-2 border-dashed px-3 py-3 text-left text-xs text-text-low hover:text-text-mid"
              >
                <Github size={14} />
                Add a git repository
              </button>
            )
          ) : compact ? (
            repos.map((r) => (
              <div
                key={r.id}
                className="glass-choice group relative mx-auto mb-1 flex h-9 w-9 items-center justify-center"
                title={r.name}
              >
                <Github size={14} className="text-text-low" />
                <button
                  className="glass-pill absolute -right-1 -top-1 hidden h-4 w-4 items-center justify-center rounded-full p-0 text-text-low hover:text-red-400 group-hover:flex"
                  onClick={() => removeRepo(r.id)}
                  title="Remove from Conductor"
                >
                  <X size={10} />
                </button>
              </div>
            ))
          ) : (
            repos.map((r) => (
              <div
                key={r.id}
                className="glass-choice group mx-1 flex w-[calc(100%-8px)] items-center gap-2 px-2 py-1.5"
              >
                <Github size={13} className="shrink-0 text-text-low" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs text-text-mid">{r.name}</div>
                  <div className="truncate font-mono text-[10px] text-text-hint">{r.path}</div>
                </div>
                <button
                  className="opacity-0 transition-opacity group-hover:opacity-100"
                  onClick={() => removeRepo(r.id)}
                  title="Remove from Conductor"
                >
                  <X size={13} className="text-text-low hover:text-red-400" />
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Footer: harness status + settings */}
      <div className={`glass-divider border-t py-3 ${compact ? 'flex flex-col items-center gap-2 px-0' : 'px-3'}`}>
        {!compact && <div className="mb-2 label">Harnesses</div>}
        <div className={`flex flex-col gap-1.5 ${compact ? 'items-center' : ''}`}>
          {harnesses.length === 0 && !compact && (
            <div className="font-mono text-[10px] text-text-hint">detecting…</div>
          )}
          {harnesses.map((h) =>
            compact ? (
              <span
                key={h.id}
                className={`h-2 w-2 rounded-full ${h.available ? '!bg-success' : ''}`}
                style={{ background: h.available ? HARNESS_INFO[h.id].accent : '#3a3a44' }}
                title={`${HARNESS_INFO[h.id].label} · ${h.available ? 'ready' : 'missing'}`}
              />
            ) : (
              <div key={h.id} className="flex items-center gap-2">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${h.available ? '!bg-success' : ''}`}
                  style={{ background: h.available ? HARNESS_INFO[h.id].accent : '#3a3a44' }}
                />
                <span className="text-xs text-text-mid">{HARNESS_INFO[h.id].label}</span>
                <span className="ml-auto font-mono text-[10px] text-text-hint">
                  {h.available ? 'ready' : 'missing'}
                </span>
              </div>
            )
          )}
        </div>
        <button
          className={`btn-ghost mt-3 ${
            compact ? 'h-9 w-9 justify-center p-0' : 'w-full justify-start'
          } ${view === 'settings' ? 'bg-accent/10 text-text-hi' : ''}`}
          onClick={openSettings}
          data-testid="open-settings"
          title="Settings"
        >
          <SettingsIcon size={15} />
          {!compact && 'Settings'}
        </button>
      </div>
    </div>
  )
}
