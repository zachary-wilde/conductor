import { Boxes, Sparkles, SquareCode, SquareTerminal } from 'lucide-react'
import { agentInfo, type HarnessId } from '@shared/types'

/**
 * The per-model mark shown on session cards, dock chips, and the launcher. Each
 * harness gets a distinct icon tinted with its own accent (from `HARNESS_INFO`);
 * a terminal session (no harness) gets the shell glyph. One place owns the
 * model → icon mapping so every surface stays consistent.
 */
const ICON: Record<HarnessId, typeof Sparkles> = {
  claude: Sparkles,
  codex: SquareCode,
  zai: Boxes
}

export function AgentIcon({
  harness,
  size = 15
}: {
  harness: HarnessId | null
  size?: number
}): JSX.Element {
  const Glyph = harness === null ? SquareTerminal : ICON[harness]
  const accent = agentInfo(harness).accent
  const box = size + 12
  return (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center rounded-lg"
      style={{
        width: box,
        height: box,
        color: accent,
        background: `color-mix(in srgb, ${accent} 16%, transparent)`,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${accent} 34%, transparent)`
      }}
    >
      <Glyph size={size} strokeWidth={2} />
    </span>
  )
}
