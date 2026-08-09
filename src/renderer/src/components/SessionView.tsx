import { useRef } from 'react'
import { useStore } from '../store/useStore'
import { TerminalView } from './Terminal'
import { DocumentWorkspace, useDocumentWorkspace } from './DocumentWorkspace'
import { SeatBar } from './SeatBar'
import { SessionInspector } from './SessionInspector'
import { useWorkspaceShell } from './WorkspaceShell'
import { PanelRightClose, PanelRightOpen } from 'lucide-react'

export function SessionView({ sessionId }: { sessionId?: string } = {}): JSX.Element {
  const sessions = useStore((s) => s.sessions)
  const storeSelected = useStore((s) => s.selectedSessionId)
  const selectedId = sessionId ?? storeSelected
  const { state, openDocument } = useDocumentWorkspace()
  const { inspectorOpen, toggleInspector } = useWorkspaceShell()
  const inspectorToggleRef = useRef<HTMLButtonElement>(null)
  const session = sessions.find((item) => item.id === selectedId)

  if (!session) return <div className="p-6 text-sm text-text-low">No session selected.</div>

  const activeKey = state.activeKeyBySession[session.id] ?? null
  const selectedPath = activeKey ? state.documents.get(activeKey)?.filePath ?? null : null

  return (
    <div className="flex h-full min-w-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="relative min-h-0 flex-1">
          <TerminalView sessionId={session.id} plainShell={session.harness === null} />
          <button
            ref={inspectorToggleRef}
            type="button"
            className="absolute right-3 top-3 rounded-md border border-edge bg-bg-1/80 p-1.5 text-text-low backdrop-blur hover:text-text-hi"
            onClick={(event) => toggleInspector(event.currentTarget)}
            aria-expanded={inspectorOpen}
            aria-controls="session-inspector"
            aria-label={inspectorOpen ? 'Hide session inspector' : 'Show session inspector'}
            title={inspectorOpen ? 'Hide session inspector' : 'Show session inspector'}
          >
            {inspectorOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
          </button>
        </div>
        <DocumentWorkspace />
        <SeatBar session={session} />
      </div>
      {inspectorOpen && (
        <div id="session-inspector" className="session-inspector-host flex min-h-0">
          <SessionInspector
            session={session}
            selectedPath={selectedPath}
            onOpenFile={(filePath) => openDocument({ sessionId: session.id, worktreePath: session.worktreePath, filePath })}
          />
        </div>
      )}
    </div>
  )
}
