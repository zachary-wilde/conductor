export type RuntimeState =
  | 'starting'
  | 'connected'
  | 'interrupted'
  | 'unavailable'
  | 'upgrade_required'
  | 'protocol_mismatch'

export interface RuntimeStatus {
  state: RuntimeState
  coreState?: string
  runtimeVersion?: string
  capabilities?: string[]
  lastReconnect?: string
  reconnectAttempt?: number
}

export interface RuntimeBridge {
  getStatus(): Promise<RuntimeStatus>
  connect(): Promise<RuntimeStatus>
  reconnect(): Promise<RuntimeStatus>
  diagnostics(): Promise<unknown>
  backup(folderUri: string): Promise<unknown>
  restore(folderUri: string): Promise<unknown>
}

type CapacitorWindow = Window & {
  Capacitor?: {
    Plugins?: {
      RuntimeBridge?: RuntimeBridge
    }
  }
}

export function getRuntimeBridge(): RuntimeBridge | null {
  return (window as CapacitorWindow).Capacitor?.Plugins?.RuntimeBridge ?? null
}

export function unavailableRuntimeStatus(): RuntimeStatus {
  return { state: 'unavailable' }
}

export function runtimeStatusLabel(status: RuntimeStatus): {
  title: string
  tone: 'danger' | 'success' | 'warning' | 'muted'
  detail: string
} {
  switch (status.state) {
    case 'connected':
      return { title: 'Connected', tone: 'success', detail: `Core ${status.coreState ?? 'unknown'}` }
    case 'starting':
      return { title: 'Starting', tone: 'warning', detail: 'Runtime is starting its foreground service.' }
    case 'interrupted':
      return { title: 'Interrupted', tone: 'warning', detail: 'Runtime work stopped; reconnect before issuing commands.' }
    case 'upgrade_required':
      return { title: 'Upgrade required', tone: 'warning', detail: 'Runtime and UI protocol versions do not match.' }
    case 'protocol_mismatch':
      return { title: 'Protocol mismatch', tone: 'danger', detail: 'This UI cannot safely control the installed Runtime.' }
    case 'unavailable':
      return { title: 'Unavailable', tone: 'danger', detail: 'Runtime service is not reachable on this tablet.' }
  }
}
