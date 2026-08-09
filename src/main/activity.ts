import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Session, SessionActivityEntry } from '@shared/types'

const execFileP = promisify(execFile)

/**
 * Live "what is the agent touching" feed.
 *
 * Harness stdout is unparseable across three different CLIs, so the source of
 * truth is the worktree itself: poll `git status --porcelain` per session and
 * diff successive snapshots into added / edited / removed events.
 */
const POLL_MS = 1500
const MAX_ENTRIES = 200

type Snapshot = Map<string, string>

const snapshots = new Map<string, Snapshot>()
let timer: NodeJS.Timeout | undefined

async function statusOf(worktreePath: string): Promise<Snapshot> {
  const snapshot: Snapshot = new Map()
  try {
    const { stdout } = await execFileP('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
      cwd: worktreePath,
      windowsHide: true,
      timeout: 5000
    })
    for (const line of stdout.split('\n')) {
      if (line.trim().length === 0) continue
      const code = line.slice(0, 2).trim()
      const file = line.slice(3).trim()
      if (file.length > 0) snapshot.set(file, code)
    }
  } catch {
    // Not a git worktree yet, or git is busy; treat as no visible changes.
  }
  return snapshot
}

function diff(previous: Snapshot, next: Snapshot, sessionId: string, now: number): SessionActivityEntry[] {
  const entries: SessionActivityEntry[] = []
  for (const [file, code] of next) {
    const before = previous.get(file)
    if (before === code) continue
    entries.push({
      id: `${sessionId}:${file}:${now}`,
      sessionId,
      path: file,
      kind: before === undefined ? (code === '??' || code === 'A' ? 'added' : 'edited') : 'edited',
      ts: now
    })
  }
  for (const file of previous.keys()) {
    if (next.has(file)) continue
    entries.push({ id: `${sessionId}:${file}:${now}:gone`, sessionId, path: file, kind: 'removed', ts: now })
  }
  return entries
}

interface Watch {
  list: () => Session[]
  emit: (entries: SessionActivityEntry[]) => void
}

let watch: Watch | undefined

function liveSessions(): Session[] {
  if (watch === undefined) return []
  return watch.list().filter((s) => s.status !== 'closed' && s.worktreePath)
}

async function tick(): Promise<void> {
  const live = liveSessions()
  // The last session can end between two ticks; disarm here as well as from
  // syncActivityWatch so no path leaves the interval running over nothing.
  if (live.length === 0 || watch === undefined) {
    disarm()
    return
  }

  const seen = new Set<string>()
  const batch: SessionActivityEntry[] = []
  const now = Date.now()

  for (const session of live) {
    seen.add(session.id)
    const next = await statusOf(session.worktreePath)
    const previous = snapshots.get(session.id)
    snapshots.set(session.id, next)
    // First sighting establishes a baseline; reporting it would spam the
    // feed with every pre-existing dirty file.
    if (previous === undefined) continue
    batch.push(...diff(previous, next, session.id, now))
  }

  for (const id of snapshots.keys()) if (!seen.has(id)) snapshots.delete(id)
  if (batch.length > 0) watch.emit(batch.slice(-MAX_ENTRIES))
}

function disarm(): void {
  if (timer !== undefined) {
    clearInterval(timer)
    timer = undefined
  }
  snapshots.clear()
}

/**
 * Registers the feed. Registering does NOT start polling — see syncActivityWatch.
 */
export function startActivityWatch(
  listSessions: () => Session[],
  emit: (entries: SessionActivityEntry[]) => void
): void {
  stopActivityWatch()
  watch = { list: listSessions, emit }
  syncActivityWatch()
}

/**
 * Arm the git poll on the first live session and disarm after the last one ends.
 *
 * This used to be an unconditional setInterval taken at launch that filtered the
 * session list *inside* the tick, so an idle Conductor woke 40x/minute forever
 * doing nothing. "An idle fleet costs nothing" is a load-bearing claim, so the
 * timer's existence — not just its work — has to be demand-driven.
 *
 * Callers fire this on every session lifecycle edge; it is idempotent.
 */
export function syncActivityWatch(): void {
  if (liveSessions().length === 0) {
    disarm()
    return
  }
  if (timer !== undefined) return
  timer = setInterval(() => void tick(), POLL_MS)
}

/** True while the poll interval is armed. The idle-cost guarantee is testable. */
export function activityWatchArmed(): boolean {
  return timer !== undefined
}

export function stopActivityWatch(): void {
  disarm()
  watch = undefined
}
