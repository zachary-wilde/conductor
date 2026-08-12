import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store/useStore'
import { TerminalView } from './Terminal'
import { DocumentWorkspace, useDocumentWorkspace } from './DocumentWorkspace'
import { SeatBar } from './SeatBar'
import { SessionInspector } from './SessionInspector'
import { PanelRightClose, PanelRightOpen, Trash2, X } from 'lucide-react'

export function SessionView({ sessionId }: { sessionId?: string } = {}): JSX.Element {
  const sessions = useStore((s) => s.sessions)
  const storeSelected = useStore((s) => s.selectedSessionId)
  const killSession = useStore((s) => s.killSession)
  const dismissSession = useStore((s) => s.dismissSession)
  const back = useStore((s) => s.back)
  const closePanel = useStore((s) => s.closePanel)
  const selectedId = sessionId ?? storeSelected
  const { state, openDocument } = useDocumentWorkspace()
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [lifecycleBusy, setLifecycleBusy] = useState(false)
  const inspectorToggleRef = useRef<HTMLButtonElement>(null)
  const session = sessions.find((item) => item.id === selectedId)

  useEffect(() => {
    if (!inspectorOpen) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        document.querySelector('[role="dialog"]')
      ) {
        return
      }
      event.preventDefault()
      setInspectorOpen(false)
      inspectorToggleRef.current?.focus()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [inspectorOpen])

  if (!session) return <div className="p-6 text-sm text-text-low">No session selected.</div>

  const activeKey = state.activeKeyBySession[session.id] ?? null
  const selectedPath = activeKey ? state.documents.get(activeKey)?.filePath ?? null : null
  const closeInspector = (): void => {
    setInspectorOpen(false)
    inspectorToggleRef.current?.focus()
  }

  const closeOrDelete = async (): Promise<void> => {
    const deleting = session.status === 'closed'
    const action = deleting ? 'Delete' : 'Close'
    if (
      !confirm(
        `${action} session?\n\n${
          deleting ? 'The session record will be removed.' : 'The process will be stopped and the closed record will remain.'
        }`
      )
    ) {
      return
    }

    setLifecycleBusy(true)
    try {
      if (deleting) {
        dismissSession(session.id)
        closePanel(`session:${session.id}`)
        back()
        return
      }

      await killSession(session.id)
    } finally {
      setLifecycleBusy(false)
    }

  }
  const isNormalSession = session.kind === 'normal'

  return (
    <div className="session-view flex h-full min-h-0 min-w-0 overflow-hidden">
      <div className="session-view__body flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="relative min-h-0 flex-1">
          <TerminalView sessionId={session.id} plainShell={session.harness === null} />
          {isNormalSession && (
            <button
              type="button"
              className="absolute right-12 top-3 rounded-md border border-edge bg-bg-1/80 p-1.5 text-text-low backdrop-blur hover:text-text-hi disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => void closeOrDelete()}
              disabled={lifecycleBusy}
              aria-label={session.status === 'closed' ? 'Delete session' : 'Close session'}
              title={session.status === 'closed' ? 'Delete session' : 'Close session'}
            >
              {session.status === 'closed' ? <Trash2 size={15} /> : <X size={15} />}
            </button>
          )}
          <button
            ref={inspectorToggleRef}
            data-testid="session-inspector-toggle"
            type="button"
            className="absolute right-3 top-3 rounded-md border border-edge bg-bg-1/80 p-1.5 text-text-low backdrop-blur hover:text-text-hi"
            onClick={() => (inspectorOpen ? closeInspector() : setInspectorOpen(true))}
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
            onOpenFile={(filePath) =>
              openDocument({ sessionId: session.id, worktreePath: session.worktreePath, filePath })
            }
            onRequestClose={closeInspector}
          />
        </div>
      )}
    </div>
  )
}
