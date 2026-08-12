// Top status bar: brand, the compatibility/read-only gate, and a connection
// status chip. The chip folds the timeline stream health into a single
// connected / reconnecting / offline indicator, marks whether the link is
// token-secured (lock), shows the core host, and opens the Connect dialog so
// the operator can retarget the core / change the token at any time.

import { Lock, Radio, ShieldAlert } from 'lucide-react'
import { useCore } from '../state/coreContext'
import { connectionStatusOf, useTimeline } from '../state/timeline'
import type { ConnectionStatus } from '../state/timeline'

const DOT: Record<ConnectionStatus, string> = {
  connected: 'bg-accent-green',
  reconnecting: 'bg-[rgb(var(--warn))]',
  offline: 'bg-[rgb(var(--danger))]'
}
const TEXT: Record<ConnectionStatus, string> = {
  connected: 'text-accent-green',
  reconnecting: 'text-[rgb(var(--warn))]',
  offline: 'text-[rgb(var(--danger))]'
}
const LABEL: Record<ConnectionStatus, string> = {
  connected: 'connected',
  reconnecting: 'reconnecting',
  offline: 'offline'
}

/** Compact host:port for the chip, falling back to the raw base on a bad URL. */
function hostOf(base: string): string {
  try {
    return new URL(base).host || base
  } catch {
    return base
  }
}

export function TopBar(): JSX.Element {
  const { handshake, compatible, apiBase, apiToken, openConnect } = useCore()
  const { status } = useTimeline()
  const conn = connectionStatusOf(status)
  const secured = apiToken.length > 0

  return (
    <header className="tablet-canvas-topbar sticky top-0 z-10 flex min-h-14 items-center gap-3 border-b border-edge bg-bg-0/80 px-4 py-3 backdrop-blur md:px-6">
      <div className="flex items-center gap-2">
        <Radio size={16} className="text-accent" />
        <span className="text-sm font-semibold tracking-tight text-text-hi">Reigen</span>
      </div>

      <div className="ml-auto flex items-center gap-3">
        {handshake && !compatible ? (
          <span className="flex items-center gap-1 rounded bg-[rgb(var(--danger))]/15 px-1.5 py-0.5 font-mono text-[10px] text-[rgb(var(--danger))]">
            <ShieldAlert size={11} />
            incompatible · read-only
          </span>
        ) : null}
        {handshake ? (
          <span className="hidden font-mono text-[10px] text-text-hint sm:inline">
            v{handshake.coreVersion}
          </span>
        ) : null}
        {/* Connection status chip: health + token lock + host. Opens Connect. */}
        <button
          onClick={openConnect}
          title={`Core: ${apiBase}`}
          aria-label="Connection settings"
          className="flex min-h-11 items-center gap-1.5 rounded-md border border-edge bg-bg-2 px-2 py-1 font-mono text-[10px] text-text-low transition-colors hover:bg-bg-3 hover:text-text-mid"
        >
          <span className={`inline-block h-1.5 w-1.5 rounded-full ${DOT[conn]}`} />
          <span className={TEXT[conn]} aria-live="polite">
            {LABEL[conn]}
          </span>
          {secured ? <Lock size={11} className="text-accent-green" /> : null}
          <span className="max-w-[10rem] truncate text-text-hint">{hostOf(apiBase)}</span>
        </button>
      </div>
    </header>
  )
}
