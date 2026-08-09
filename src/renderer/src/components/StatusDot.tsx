import type { SessionStatus } from '@shared/types'
import { STATUS_META } from '../lib/ui'

export function StatusDot({ status }: { status: SessionStatus }): JSX.Element {
  const meta = STATUS_META[status]
  return (
    <span className="relative flex h-2.5 w-2.5">
      {meta.pulse && (
        <span
          className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${status === 'running' ? '!bg-success' : ''}`}
          style={{ background: meta.color }}
        />
      )}
      <span
        className={`relative inline-flex h-2.5 w-2.5 rounded-full ${status === 'running' ? '!bg-success' : ''}`}
        style={{ background: meta.color }}
      />
    </span>
  )
}
