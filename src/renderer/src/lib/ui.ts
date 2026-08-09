import type { HarnessId, SessionStatus } from '@shared/types'

export const STATUS_META: Record<
  SessionStatus,
  { label: string; color: string; pulse?: boolean }
> = {
  starting: { label: 'Starting', color: '#6b6b76' },
  running: { label: 'Generating', color: '#34c759', pulse: true },
  'needs-input': { label: 'Needs attention', color: '#ff9500', pulse: true },
  closed: { label: 'Done', color: '#6b6b76' },
  error: { label: 'Error', color: '#ef4444' }
}

export function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

export function harnessInitial(id: HarnessId): string {
  return id === 'zai' ? 'Z' : id === 'codex' ? 'C' : 'A'
}
