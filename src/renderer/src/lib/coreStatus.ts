/**
 * Core connection status, pushed by the main-process connection manager. The
 * renderer mirrors the shape rather than importing preload internals so the
 * banner logic stays pure and testable without a window.
 *
 * - `connecting`: reaching/spawning the Core (startup or after a drop).
 * - `connected`: healthy.
 * - `error`: the last attempt failed; the manager keeps retrying on its own,
 *   and `reconnectCore()` forces an immediate retry.
 */
export type CoreStatusState = 'connecting' | 'connected' | 'error'

export interface CoreStatus {
  state: CoreStatusState
  detail?: string
}

export type CoreStatusTone = 'connecting' | 'error'

export interface CoreStatusBanner {
  tone: CoreStatusTone
  message: string
}

/** Extract the diagnostic log path carried in an error detail, if present. */
export function coreStatusLogPath(detail: string | undefined): string | null {
  const line = detail?.split(/\r?\n/).find((entry) => entry.startsWith('Core log: '))
  return line ? line.slice('Core log: '.length) : null
}

/**
 * Derive the banner for a Core status. Returns `null` when the Core is healthy
 * — the connected state paints nothing, so the workspace stays clean and a strip
 * only ever appears when something needs the operator's attention. `detail` is
 * surfaced by the view (small/muted), not folded into the banner copy.
 */
export function coreStatusBanner(status: CoreStatus): CoreStatusBanner | null {
  switch (status.state) {
    case 'connecting':
      return { tone: 'connecting', message: 'Connecting to Conductor Core…' }
    case 'error':
      return { tone: 'error', message: 'Conductor Core unavailable — retrying…' }
    case 'connected':
      return null
  }
}
