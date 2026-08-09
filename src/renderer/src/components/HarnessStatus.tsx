import type { HarnessAvailability } from '@shared/types'
import { HarnessBadge } from './HarnessBadge'

/**
 * The harness-availability row shared by the canvas empty-state CTA and the
 * Repositories popover. When at least one agent CLI is detected each harness
 * gets a badge with an available/missing dot; otherwise a single line nudges
 * the operator to install one. This is the only place the install hint lives.
 */
export function HarnessStatus({ harnesses }: { harnesses: HarnessAvailability[] }): JSX.Element {
  const anyAvailable = harnesses.some((h) => h.available)
  if (!anyAvailable) {
    return (
      <div data-testid="harness-status" className="text-center">
        <p className="text-[11px] text-text-low">
          No agent CLIs detected — install Claude, Codex, or omp to run agents.
        </p>
      </div>
    )
  }
  return (
    <div data-testid="harness-status" className="flex items-center justify-center gap-3">
      {harnesses.map((h) => (
        <span
          key={h.id}
          className="inline-flex items-center gap-1.5"
          style={{ opacity: h.available ? 1 : 0.4 }}
          title={h.available ? `${h.info.label} · available` : `${h.info.label} · not detected`}
        >
          <HarnessBadge id={h.id} size={18} />
          <span
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ background: h.available ? '#10a37f' : '#ef4444' }}
          />
        </span>
      ))}
    </div>
  )
}
