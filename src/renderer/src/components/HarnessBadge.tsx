import type { HarnessId } from '@shared/types'
import { agentInfo } from '@shared/types'

/** Two-letter mark for the agent behind a session. `>_` is a terminal. */
function mark(id: HarnessId | null): string {
  if (id === null) return '>_'
  return id === 'zai' ? 'Z' : id === 'codex' ? 'Cx' : 'Cl'
}

export function HarnessBadge({ id, size = 20 }: { id: HarnessId | null; size?: number }): JSX.Element {
  const info = agentInfo(id)
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-md font-mono text-[10px] font-semibold"
      style={{
        width: size,
        height: size,
        background: `${info.accent}22`,
        color: info.accent,
        border: `1px solid ${info.accent}44`
      }}
      title={`${info.label} · ${info.provider}`}
    >
      {mark(id)}
    </span>
  )
}
