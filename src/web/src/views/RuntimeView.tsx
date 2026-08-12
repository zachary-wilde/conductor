import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw, RotateCcw, ShieldCheck, Terminal, Wrench } from 'lucide-react'
import { Badge, Button, EmptyState, Notice, Spinner } from '../components/ui'
import {
  getRuntimeBridge,
  runtimeStatusLabel,
  unavailableRuntimeStatus,
  type RuntimeStatus
} from '../state/runtime'

const toneClass = {
  danger: 'bg-[rgb(var(--danger))]/10 text-[rgb(var(--danger))]',
  success: 'bg-accent-green/10 text-accent-green',
  warning: 'bg-[rgb(var(--warn))]/10 text-[rgb(var(--warn))]',
  muted: 'bg-bg-3 text-text-low'
} as const

export function RuntimeView(): JSX.Element {
  const bridge = useMemo(() => getRuntimeBridge(), [])
  const [status, setStatus] = useState<RuntimeStatus>(unavailableRuntimeStatus)
  const [diagnostics, setDiagnostics] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    if (!bridge) {
      setStatus(unavailableRuntimeStatus())
      return
    }
    setBusy(true)
    setError(null)
    try {
      setStatus(await bridge.getStatus())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Runtime status request failed.')
      setStatus(unavailableRuntimeStatus())
    } finally {
      setBusy(false)
    }
  }, [bridge])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const runAction = async (action: 'connect' | 'reconnect' | 'diagnostics'): Promise<void> => {
    if (!bridge) return
    setBusy(true)
    setError(null)
    setDiagnostics(null)
    try {
      if (action === 'diagnostics') {
        setDiagnostics(JSON.stringify(await bridge.diagnostics(), null, 2))
      } else {
        setStatus(await bridge[action]())
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Runtime operation failed.')
    } finally {
      setBusy(false)
    }
  }

  const label = runtimeStatusLabel(status)
  const canOperate = bridge !== null

  return (
    <div className="flex flex-col gap-5">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-sm font-semibold text-text-hi">This tablet</h1>
          <Badge className={toneClass[label.tone]}>{label.title}</Badge>
        </div>
        <p className="mt-1 text-xs text-text-low">
          Runtime, Core, terminal sessions, projects, and recovery stay on this device.
        </p>
      </div>

      {error ? <Notice tone="error">{error}</Notice> : null}

      <section className="rounded-lg border border-edge bg-bg-1 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-text-hi">
              <ShieldCheck size={16} className="text-accent" /> Runtime service
            </div>
            <p className="mt-1 text-xs text-text-low">{label.detail}</p>
          </div>
          {busy ? <Spinner /> : null}
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
          <RuntimeFact label="Version" value={status.runtimeVersion ?? '—'} />
          <RuntimeFact label="Core" value={status.coreState ?? '—'} />
          <RuntimeFact label="Reconnects" value={String(status.reconnectAttempt ?? 0)} />
          <RuntimeFact label="Last seen" value={status.lastReconnect ?? '—'} />
        </dl>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button disabled={!canOperate || busy} onClick={() => void runAction('connect')} variant="primary">
            <Terminal size={14} /> Connect
          </Button>
          <Button disabled={!canOperate || busy} onClick={() => void runAction('reconnect')}>
            <RotateCcw size={14} /> Reconnect
          </Button>
          <Button disabled={busy} onClick={() => void refresh()}>
            <RefreshCw size={14} /> Refresh
          </Button>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2">
        <PanelCard
          icon={<Terminal size={16} className="text-accent" />}
          title="Terminal and projects"
          body="Persistent PTYs and app-private repositories attach here when the Runtime is connected."
        />
        <PanelCard
          icon={<Wrench size={16} className="text-accent" />}
          title="Backup and restore"
          body="SD-card backup controls appear after the Android folder is authorized."
        />
      </section>

      <section className="rounded-lg border border-edge bg-bg-1 p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium text-text-hi">Diagnostics</h2>
            <p className="mt-1 text-xs text-text-low">Secret-free Runtime health data for troubleshooting.</p>
          </div>
          <Button disabled={!canOperate || busy} onClick={() => void runAction('diagnostics')}>
            Collect
          </Button>
        </div>
        {diagnostics ? (
          <pre className="mt-3 max-h-64 overflow-auto rounded-md bg-bg-0 p-3 font-mono text-[10px] text-text-mid">
            {diagnostics}
          </pre>
        ) : (
          <EmptyState title="No report collected" body="Collect diagnostics after connecting the tablet Runtime." />
        )}
      </section>
    </div>
  )
}

function RuntimeFact({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wide text-text-hint">{label}</dt>
      <dd className="mt-1 truncate font-mono text-text-mid">{value}</dd>
    </div>
  )
}

function PanelCard({
  icon,
  title,
  body
}: {
  icon: JSX.Element
  title: string
  body: string
}): JSX.Element {
  return (
    <div className="rounded-lg border border-edge bg-bg-1 p-4">
      <div className="flex items-center gap-2 text-sm font-medium text-text-hi">
        {icon}
        {title}
      </div>
      <p className="mt-2 text-xs leading-5 text-text-low">{body}</p>
    </div>
  )
}
