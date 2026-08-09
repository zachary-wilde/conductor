import type { ReactNode } from 'react'
import type { Session } from '@shared/types'
import { GitBranch, Folder, MessageSquare } from 'lucide-react'
import { FileViewer } from './FileViewer'

export interface SessionInspectorProps {
  session: Session
  selectedPath: string | null
  onOpenFile: (path: string) => void
}

export function SessionInspector({ session, selectedPath, onOpenFile }: SessionInspectorProps): JSX.Element {
  return (
    <aside className="glass-bar session-inspector flex min-h-0 w-[340px] shrink-0 flex-col border-l" aria-label="Session inspector">
      <div className="glass-divider flex flex-col gap-2 border-b px-4 py-3 font-mono text-[11px]">
        <Row icon={<GitBranch size={11} />} label="Branch" value={session.branch} />
        <Row icon={<Folder size={11} />} label="Worktree" value={session.worktreePath} />
      </div>
      {session.initialPrompt && (
        <div className="glass-divider border-b px-4 py-3">
          <div className="mb-1.5 flex items-center gap-1.5 label"><MessageSquare size={11} /> Prompt</div>
          <p className="text-xs leading-relaxed text-text-mid">{session.initialPrompt}</p>
        </div>
      )}
      <div className="min-h-0 flex-1">
        <FileViewer root={session.worktreePath} onOpenFile={onOpenFile} selectedPath={selectedPath} />
      </div>
    </aside>
  )
}

function Row({ icon, label, value }: { icon: ReactNode; label: string; value: string }): JSX.Element {
  return <div className="flex items-start gap-2"><span className="mt-0.5 text-text-hint">{icon}</span><span className="w-14 shrink-0 text-text-hint">{label}</span><span className="min-w-0 flex-1 break-all text-text-low" title={value}>{value}</span></div>
}
