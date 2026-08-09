import { useStore } from '../store/useStore'
import { Boxes, FolderPlus, Plus } from 'lucide-react'

export function EmptyState(): JSX.Element {
  const repos = useStore((s) => s.repos)
  const toggleNewSession = useStore((s) => s.toggleNewSession)
  const addRepo = useStore((s) => s.addRepo)

  const pickRepo = async (): Promise<void> => {
    const p = await window.api.pickDirectory()
    if (p) await addRepo(p)
  }

  return (
    <div className="flex max-w-sm flex-col items-center text-center">
      <div className="glass-panel mb-4 flex h-14 w-14 items-center justify-center rounded-2xl text-accent">
        <Boxes size={28} />
      </div>
      <h2 className="text-lg font-semibold">Command a fleet of agents</h2>
      <p className="mt-2 text-sm text-text-low">
        Run Claude Code, Codex, and ZAI coding sessions in parallel — each in its own isolated git
        worktree. Bring your own subscription; everything runs on your machine.
      </p>

      <div className="mt-6 flex flex-col gap-2">
        {repos.length === 0 ? (
          <button className="btn-primary" onClick={pickRepo}>
            <FolderPlus size={15} /> Add a repository
          </button>
        ) : (
          <button className="btn-primary" onClick={() => toggleNewSession(true)}>
            <Plus size={15} /> Start your first session
          </button>
        )}
        {repos.length > 0 && (
          <button className="btn-ghost" onClick={pickRepo}>
            <FolderPlus size={15} /> Add another repo
          </button>
        )}
      </div>
    </div>
  )
}
