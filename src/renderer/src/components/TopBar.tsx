import { useStore } from '../store/useStore'
import { agentInfo } from '@shared/types'
import { ArrowLeft, Terminal, Square, GitBranch, FolderTree } from 'lucide-react'
import { HarnessBadge } from './HarnessBadge'
import { StatusDot } from './StatusDot'

export function TopBar(): JSX.Element {
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  const sessions = useStore((s) => s.sessions)
  const selectedId = useStore((s) => s.selectedSessionId)
  const killSession = useStore((s) => s.killSession)

  const session = sessions.find((s) => s.id === selectedId) || null

  return (
    <header className="glass-bar flex h-12 shrink-0 items-center gap-3 border-b px-4">
      {view === 'dashboard' && (
        <>
          <Terminal size={16} className="text-text-low" />
          <h1 className="text-sm font-medium">Sessions</h1>
          <span className="glass-pill h-auto rounded-full px-2 py-0.5 font-mono text-[10px] text-text-low">
            {sessions.length}
          </span>
          <span className="ml-auto font-mono text-[10px] text-text-hint">
            Ctrl+N · new session
          </span>
        </>
      )}

      {view === 'session' && session && (
        <>
          <button className="btn-ghost px-2" onClick={() => setView('dashboard')} data-testid="back" aria-label="Back" title="Back">
            <ArrowLeft size={16} />
          </button>
          <HarnessBadge id={session.harness} />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">
              {session.title || `${agentInfo(session.harness).label} session`}
            </div>
            <div className="flex items-center gap-2 font-mono text-[10px] text-text-hint">
              <span className="inline-flex items-center gap-1">
                <GitBranch size={10} /> {session.branch}
              </span>
              <span>·</span>
              <span>{agentInfo(session.harness).provider}</span>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <button
              className="btn-outline"
              onClick={() => window.api.openPath(session.worktreePath)}
              title="Open worktree folder"
            >
              <FolderTree size={14} /> Reveal
            </button>
            <span className="flex items-center gap-2 font-mono text-[11px] text-text-low">
              <StatusDot status={session.status} />
            </span>
            <button
              className="btn-outline border-red-500/30 text-red-400 hover:bg-red-500/10"
              onClick={() => killSession(session.id)}
              title="Stop session"
            >
              <Square size={13} /> Stop
            </button>
          </div>
        </>
      )}

      {view === 'settings' && (
        <>
          <button className="btn-ghost px-2" onClick={() => setView('dashboard')} data-testid="back" aria-label="Back" title="Back">
            <ArrowLeft size={16} />
          </button>
          <h1 className="text-sm font-medium">Settings</h1>
        </>
      )}
    </header>
  )
}
