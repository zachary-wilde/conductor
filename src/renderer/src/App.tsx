import { lazy, Suspense, useEffect } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import { useStore } from './store/useStore'
import { Canvas } from './components/Canvas'
import { CanvasBar } from './components/CanvasBar'
import { TitleBar } from './components/TitleBar'
import { CoreStatusBanner } from './components/CoreStatusBanner'
import { DocumentWorkspaceProvider } from './components/DocumentWorkspace'
import { StoreRecoveryPanel } from './components/StoreRecoveryPanel'

const NewSessionModal = lazy(() =>
  import('./components/NewSessionModal').then((m) => ({ default: m.NewSessionModal }))
)
const NewRavelModal = lazy(() =>
  import('./components/NewRavelModal').then((m) => ({ default: m.NewRavelModal }))
)
const NewRoundtableModal = lazy(() =>
  import('./components/NewRoundtableModal').then((m) => ({ default: m.NewRoundtableModal }))
)

/**
 * One canvas, always. Views are floating panels on it rather than routes that
 * replace the shell, so opening a ravel no longer swaps the whole application
 * for a different-looking one.
 */
export default function App(): JSX.Element {
  const init = useStore((s) => s.init)
  const showNewSession = useStore((s) => s.showNewSession)
  const showNewRavel = useStore((s) => s.showNewRavel)
  const showNewRoundtable = useStore((s) => s.showNewRoundtable)
  const error = useStore((s) => s.error)
  const clearError = useStore((s) => s.clearError)

  useEffect(() => {
    void init()
  }, [init])

  return (
    <div data-startup-ready className="app-base flex h-screen w-screen flex-col overflow-hidden text-text-hi">
      <TitleBar />
      <CoreStatusBanner />
      <StoreRecoveryPanel />
      <CanvasBar />
      {/* One document workspace for the whole canvas: state is keyed by sessionId,
          so every session panel stays isolated while the Sessions rail and panels
          share a single provider (a card in the rail also needs this context). */}
      <DocumentWorkspaceProvider>
        <div className="relative min-h-0 flex-1">
          <Canvas />
        </div>
      </DocumentWorkspaceProvider>

      <Suspense fallback={null}>
        {showNewSession && <NewSessionModal />}
        {showNewRavel && <NewRavelModal />}
        {showNewRoundtable && <NewRoundtableModal />}
      </Suspense>

      {error && (
        <div className="fixed bottom-4 right-4 z-50 flex max-w-md items-start gap-3 rounded-lg border border-red-500/30 bg-bg-2 px-4 py-3 shadow-2xl">
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-red-400" />
          <div className="min-w-0 flex-1 text-sm text-text-mid">{error}</div>
          <button onClick={clearError} className="text-text-low hover:text-text-hi">
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  )
}
