import { useEffect } from 'react'
import { useStore } from '../store/useStore'
import { SessionCard } from './SessionCard'
import { EmptyState } from './EmptyState'
import { Plus } from 'lucide-react'

export function Dashboard(): JSX.Element {
  const sessions = useStore((s) => s.sessions).filter((s) => s.kind === 'normal')
  const repos = useStore((s) => s.repos)
  const toggleNewSession = useStore((s) => s.toggleNewSession)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        if (repos.length > 0) toggleNewSession(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [repos.length, toggleNewSession])

  if (sessions.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <EmptyState />
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-6xl">
        <div className="glass-panel mb-4 flex items-center justify-between p-3">
          <p className="text-sm text-text-low">
            {sessions.length} session{sessions.length === 1 ? '' : 's'} · each isolated in its own
            git worktree
          </p>
          <button className="btn-outline" onClick={() => toggleNewSession(true)}>
            <Plus size={15} /> New session
          </button>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {sessions.map((s) => (
            <SessionCard key={s.id} session={s} />
          ))}
        </div>
      </div>
    </div>
  )
}
