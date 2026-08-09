import { AlertTriangle, FileText, Loader2, RefreshCw } from 'lucide-react'
import { coreStatusBanner, coreStatusLogPath } from '../lib/coreStatus'
import { useStore } from '../store/useStore'

/**
 * Thin top strip that surfaces Core connection state. Hidden entirely once the
 * Core is healthy; a subtle "connecting" line while it reaches the Core, and a
 * prominent red strip with a Retry button when the last attempt failed. Never a
 * modal — the workspace stays visible underneath so a dropped Core never reads
 * as data loss.
 */
export function CoreStatusBanner(): JSX.Element | null {
  const status = useStore((s) => s.coreStatus)
  const reconnectCore = useStore((s) => s.reconnectCore)
  const banner = coreStatusBanner(status)
  const logPath = coreStatusLogPath(status.detail)
  if (banner === null) return null

  if (banner.tone === 'error') {
    return (
      <div className="flex shrink-0 items-center gap-2 border-b border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs">
        <AlertTriangle size={13} className="shrink-0 text-red-400" />
        <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="font-medium text-red-300">{banner.message}</span>
          {status.detail && (
            <div className="min-w-0 flex-1 break-words text-text-low">
              {status.detail.split(/\r?\n/).map((line, index) => (
                <div key={`${index}-${line}`}>{line}</div>
              ))}
            </div>
          )}
        </div>
        {logPath && (
          <button
            className="btn-outline flex shrink-0 items-center gap-1 px-2 py-0.5 text-xs"
            onClick={() => void window.api.openPath(logPath)}
          >
            <FileText size={12} /> Open logs
          </button>
        )}
        <button
          className="btn-outline flex shrink-0 items-center gap-1 px-2 py-0.5 text-xs"
          onClick={() => void reconnectCore()}
        >
          <RefreshCw size={12} /> Retry
        </button>
      </div>
    )
  }

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-edge bg-bg-0 px-3 py-1.5 text-xs text-text-mid">
      <Loader2 size={13} className="shrink-0 animate-spin text-text-low" />
      <span>{banner.message}</span>
    </div>
  )
}
