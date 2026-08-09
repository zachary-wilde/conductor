import { Database, Download, RotateCcw, Upload } from 'lucide-react'
import { useStore } from '../store/useStore'

/** Explicit, user-controlled recovery actions for an unreadable persisted store. */
export function StoreRecoveryPanel(): JSX.Element | null {
  const loadError = useStore((state) => state.storeLoadError)
  const resetCorruptStore = useStore((state) => state.resetCorruptStore)
  const exportStore = useStore((state) => state.exportStore)
  const importStore = useStore((state) => state.importStore)

  if (!loadError) return null

  return (
    <section
      role="alert"
      className="mx-3 mt-3 shrink-0 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm"
    >
      <div className="flex items-start gap-3">
        <Database size={18} className="mt-0.5 shrink-0 text-amber-300" />
        <div className="min-w-0 flex-1">
          <h2 className="font-medium text-amber-200">Saved state needs recovery</h2>
          <p className="mt-1 text-xs text-text-mid">
            Conductor kept the unreadable file and will not overwrite it until you reset or import a valid store.
          </p>
          <p className="mt-1 break-words font-mono text-xs text-text-low">{loadError}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              className="btn-outline flex items-center gap-1.5 px-2 py-1 text-xs"
              onClick={() => {
                if (window.confirm('Reset Conductor to an empty store? The corrupt file is already backed up.')) {
                  void resetCorruptStore()
                }
              }}
            >
              <RotateCcw size={13} /> Reset store
            </button>
            <button className="btn-outline flex items-center gap-1.5 px-2 py-1 text-xs" onClick={() => void exportStore()}>
              <Download size={13} /> Export file
            </button>
            <button className="btn-outline flex items-center gap-1.5 px-2 py-1 text-xs" onClick={() => void importStore()}>
              <Upload size={13} /> Import file
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}
