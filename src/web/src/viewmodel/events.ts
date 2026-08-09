// Pure view-model: presentation helpers for normalized events.
//
// Maps an `EventKind` to a label + tone, and formats timestamps for a dense,
// scannable timeline. No I/O and no React; the clock is injected so relative
// formatting is deterministic under test.

import type { EventKind, NormalizedEvent } from '@ops/events'

/** Visual tone for an event kind, mirrored to a Tailwind text/border class. */
export type Tone =
  | 'neutral'
  | 'accent'
  | 'blue'
  | 'cyan'
  | 'green'
  | 'amber'
  | 'red'
  | 'purple'

export interface KindMeta {
  /** Short uppercase label for grouping headers and row chips. */
  label: string
  tone: Tone
}

/**
 * One entry per `EventKind`. Tones are semantic, not decorative: green is a
 * success/approval, red is a failure/rejection, amber is a budget/control
 * request, purple is automation, blue is commits/verification, cyan is
 * conversation, accent is lifecycle/tool/file.
 */
const KIND_META: Record<EventKind, KindMeta> = {
  lifecycle: { label: 'LIFECYCLE', tone: 'accent' },
  conversation: { label: 'TALK', tone: 'cyan' },
  tool: { label: 'TOOL', tone: 'accent' },
  file: { label: 'FILE', tone: 'accent' },
  commit: { label: 'COMMIT', tone: 'blue' },
  verification: { label: 'VERIFY', tone: 'blue' },
  approval: { label: 'APPROVE', tone: 'green' },
  rejection: { label: 'REJECT', tone: 'red' },
  budget: { label: 'BUDGET', tone: 'amber' },
  automation: { label: 'AUTO', tone: 'purple' },
  'control-request': { label: 'CTRL?', tone: 'amber' },
  'control-result': { label: 'CTRL', tone: 'amber' },
  failure: { label: 'FAIL', tone: 'red' },
  interruption: { label: 'INTERRUPT', tone: 'red' }
}

/** The label + tone for an event kind; never throws. */
export function kindMeta(kind: EventKind): KindMeta {
  return KIND_META[kind] ?? { label: kind.toUpperCase(), tone: 'neutral' }
}

/** Tailwind class fragment for a tone's foreground colour. */
export function toneText(tone: Tone): string {
  switch (tone) {
    case 'accent':
      return 'text-accent'
    case 'blue':
      return 'text-accent-blue'
    case 'cyan':
      return 'text-accent-cyan'
    case 'green':
      return 'text-accent-green'
    case 'amber':
      return 'text-[rgb(var(--warn))]'
    case 'red':
      return 'text-[rgb(var(--danger))]'
    case 'purple':
      return 'text-accent-purple'
    default:
      return 'text-text-mid'
  }
}

/** Tailwind class fragment for a tone's chip background. */
export function toneChip(tone: Tone): string {
  switch (tone) {
    case 'accent':
      return 'bg-accent/15 text-accent'
    case 'blue':
      return 'bg-accent-blue/15 text-accent-blue'
    case 'cyan':
      return 'bg-accent-cyan/15 text-accent-cyan'
    case 'green':
      return 'bg-accent-green/15 text-accent-green'
    case 'amber':
      return 'bg-[rgb(var(--warn))]/15 text-[rgb(var(--warn))]'
    case 'red':
      return 'bg-[rgb(var(--danger))]/15 text-[rgb(var(--danger))]'
    case 'purple':
      return 'bg-accent-purple/15 text-accent-purple'
    default:
      return 'bg-bg-3 text-text-mid'
  }
}

/**
 * `HH:MM:SS` in the host timezone. Deterministic given the same wall clock;
 * used for the timestamp column so a glance aligns across rows.
 */
export function formatClock(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/**
 * Compact relative time ("12s", "4m", "2h", "3d") from `now - ts`. `now` is
 * injected so the formatter is pure and testable; the UI passes `Date.now()`.
 */
export function formatRelative(ts: number, now: number): string {
  const secs = Math.max(0, Math.floor((now - ts) / 1000))
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  const days = Math.floor(hrs / 24)
  return `${days}d`
}

/**
 * Group cursor-ordered events into consecutive runs of the same kind, preserving
 * order. The timeline renders a kind header before each run so the stream stays
 * scannable without re-sorting events out of cursor order.
 */
export interface EventGroup {
  kind: EventKind
  events: NormalizedEvent[]
}

export function groupByKind(events: readonly NormalizedEvent[]): EventGroup[] {
  const groups: EventGroup[] = []
  for (const ev of events) {
    const last = groups[groups.length - 1]
    if (last && last.kind === ev.kind) {
      last.events.push(ev)
    } else {
      groups.push({ kind: ev.kind, events: [ev] })
    }
  }
  return groups
}
