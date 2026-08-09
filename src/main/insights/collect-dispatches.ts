import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { PublicRavelConfig, RavelBrief, RavelDispatchRecord } from '@shared/types'
import type { InsightDispatchSnapshot } from './types'

const execFileP = promisify(execFile)

/**
 * Git facts about what each child actually changed in its own worktree.
 *
 * This is the only part of the insight engine that touches the filesystem, and it is
 * the reason `note()` is fire-and-forget: no orchestration path ever waits on git.
 * Everything here is bounded — a timeout, an output ceiling, a concurrency limit, and
 * an in-flight map so two triggers a millisecond apart share one measurement.
 */

const TIMEOUT_MS = 5_000
const MAX_BUFFER = 4 * 1024 * 1024
/** Worktrees measured at once. Three keeps a large fleet off the disk head. */
const CONCURRENCY = 3
/** An untracked file bigger than this is counted as changed but not line-counted. */
const MAX_UNTRACKED_BYTES = 256 * 1024

export interface DispatchMetrics {
  changedPaths: string[]
  additions: number
  deletions: number
  commits: number
}

const inFlight = new Map<string, Promise<DispatchMetrics | null>>()

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP('git', ['-C', cwd, ...args], {
    windowsHide: true,
    timeout: TIMEOUT_MS,
    maxBuffer: MAX_BUFFER
  })
  return stdout
}

/** `-z` output is NUL-terminated, not NUL-separated, so the tail is empty. */
function splitNul(out: string): string[] {
  return out.split('\0').filter((entry) => entry.length > 0)
}

const normalise = (path: string): string => path.replace(/\\/g, '/')

/**
 * `--numstat -z` emits `additions\tdeletions\tpath\0`; binary files report `-` for
 * both counts, which must not be parsed as zero and silently understate a change.
 */
function parseNumstat(out: string): { paths: string[]; additions: number; deletions: number } {
  const paths: string[] = []
  let additions = 0
  let deletions = 0
  for (const record of splitNul(out)) {
    const tab = record.indexOf('\t')
    if (tab < 0) continue
    const secondTab = record.indexOf('\t', tab + 1)
    if (secondTab < 0) continue
    const added = record.slice(0, tab)
    const removed = record.slice(tab + 1, secondTab)
    const path = record.slice(secondTab + 1)
    if (path.length === 0) continue
    paths.push(normalise(path))
    if (added !== '-') additions += Number(added) || 0
    if (removed !== '-') deletions += Number(removed) || 0
  }
  return { paths, additions, deletions }
}

/**
 * Untracked files have no diff, so their whole contents are the addition. Bounded by
 * size: a child that dropped a 50 MB artifact should not be line-counted.
 */
async function untrackedAdditions(worktreePath: string, paths: string[]): Promise<number> {
  let additions = 0
  for (const path of paths) {
    try {
      const full = join(worktreePath, path)
      const info = await stat(full)
      if (!info.isFile() || info.size > MAX_UNTRACKED_BYTES) continue
      const text = await readFile(full, 'utf8')
      if (text.length === 0) continue
      additions += text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length
    } catch {
      // A file that vanished mid-measurement still counts as changed; it just
      // contributes no lines.
    }
  }
  return additions
}

/**
 * Returns null when the dispatch cannot be measured honestly — no base commit, or a
 * worktree git refuses to read. A null is dropped by the caller rather than reported
 * as an empty diff, because "changed nothing" is itself an insight and must never be
 * manufactured from a failed command.
 */
async function measure(worktreePath: string, baseCommit: string): Promise<DispatchMetrics | null> {
  try {
    const [numstat, untracked, revList] = await Promise.all([
      git(worktreePath, ['diff', '--numstat', '--no-renames', '-z', baseCommit, '--']),
      git(worktreePath, ['ls-files', '--others', '--exclude-standard', '-z']),
      git(worktreePath, ['rev-list', '--count', `${baseCommit}..HEAD`])
    ])

    const tracked = parseNumstat(numstat)
    const untrackedPaths = splitNul(untracked).map(normalise)
    const merged = [...new Set([...tracked.paths, ...untrackedPaths])].sort()

    return {
      changedPaths: merged,
      additions: tracked.additions + (await untrackedAdditions(worktreePath, untrackedPaths)),
      deletions: tracked.deletions,
      commits: Number(revList.trim()) || 0
    }
  } catch {
    return null
  }
}

/** Shared across concurrent triggers for the same worktree at the same base. */
function measureOnce(worktreePath: string, baseCommit: string): Promise<DispatchMetrics | null> {
  const key = `${worktreePath}\u0000${baseCommit}`
  const existing = inFlight.get(key)
  if (existing) return existing
  const run = measure(worktreePath, baseCommit).finally(() => inFlight.delete(key))
  inFlight.set(key, run)
  return run
}

/** Bounded fan-out. Preserves input order so the caller can zip results back. */
async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let index = next++; index < items.length; index = next++) {
      results[index] = await fn(items[index])
    }
  })
  await Promise.all(workers)
  return results
}

/** briefId:startedAt:branch — stable for a dispatch's whole life, unique per attempt. */
const dispatchKey = (d: RavelDispatchRecord): string => `${d.briefId}:${d.startedAt}:${d.branch}`

export async function collectDispatches(
  ravel: PublicRavelConfig | null
): Promise<InsightDispatchSnapshot[]> {
  if (ravel === null) return []
  const briefs = new Map<string, RavelBrief>(
    (ravel.plan?.briefs ?? []).map((brief) => [brief.id, brief])
  )
  const attempts = new Map<string, number>()

  const measurable = ravel.dispatches.filter((d) => d.baseCommit !== null)
  const metrics = await mapLimited(measurable, CONCURRENCY, (d) =>
    measureOnce(d.worktreePath, d.baseCommit as string)
  )
  const byKey = new Map<string, DispatchMetrics>()
  measurable.forEach((d, index) => {
    const measured = metrics[index]
    if (measured !== null) byKey.set(dispatchKey(d), measured)
  })

  const snapshots: InsightDispatchSnapshot[] = []
  for (const dispatch of ravel.dispatches) {
    const attempt = (attempts.get(dispatch.briefId) ?? 0) + 1
    attempts.set(dispatch.briefId, attempt)

    const measured = byKey.get(dispatchKey(dispatch))
    // Unmeasurable dispatches are omitted rather than reported as zero-change: a
    // false "this child touched nothing" is worse than saying nothing at all.
    if (measured === undefined) continue

    // A dispatch whose brief was revised away has no role, no title and no
    // doNotTouch list. Substituting defaults would put an invented role into the
    // per-role median and a "changed a protected path" rule with no guards to
    // check, so it is dropped — the attempt counter above still saw it.
    const brief = briefs.get(dispatch.briefId)
    if (brief === undefined) continue

    snapshots.push({
      key: dispatchKey(dispatch),
      briefId: dispatch.briefId,
      briefTitle: brief.title,
      role: brief.role,
      harness: brief.harness,
      model: brief.model,
      status: dispatch.status,
      startedAt: dispatch.startedAt,
      endedAt: dispatch.endedAt,
      changedPaths: measured.changedPaths,
      protectedPaths: brief.doNotTouch,
      additions: measured.additions,
      deletions: measured.deletions,
      commits: measured.commits,
      contextRequests: dispatch.contextRequests,
      attempt,
      usage: dispatch.usage,
      verification: dispatch.verification
    })
  }
  return snapshots
}
