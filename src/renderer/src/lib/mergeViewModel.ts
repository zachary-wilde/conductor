import type { MergeFailure, MergeLanded, MergePreviewEntry, PublicRavelConfig } from '@shared/types'

/** A completed brief's branch, offered for review and landing. */
export interface MergeReviewRow {
  briefId: string
  branch: string
  title: string
  planRevision: number
  /**
   * When the dispatch behind this row started. Part of the row's identity: a
   * brief re-dispatched onto the same branch produces a different tip, so a
   * preview or a landing recorded against the previous run must not be shown
   * against this one.
   */
  startedAt: number
}

/** What happened when a branch was landed, plus how it was landed. */
export interface LandedRecord {
  result: MergeLanded
  /** A squash merge rewrites the commits, so `git branch -d` refuses it afterwards. */
  squashed: boolean
}

export type MergeReviewSeverity =
  | 'deleted'
  | 'landed'
  | 'clean'
  | 'overlap'
  | 'conflict'
  | 'unknown'
  | 'unchecked'

export interface MergeReviewState {
  severity: MergeReviewSeverity
  label: string
  color: string
  canLand: boolean
  /** Only a branch that landed as real commits can be deleted. */
  canDelete: boolean
}

const SEVERITY_STYLE: Record<MergeReviewSeverity, { label: string; color: string }> = {
  deleted: { label: 'branch deleted', color: '#6b6b76' },
  landed: { label: 'landed', color: '#32d4de' },
  clean: { label: 'merges cleanly', color: '#34c759' },
  overlap: { label: 'overlaps siblings', color: '#ff9500' },
  conflict: { label: 'conflicts with base', color: '#ef4444' },
  unknown: { label: 'could not be checked', color: '#ff9500' },
  unchecked: { label: 'not previewed', color: '#6b6b76' }
}

/**
 * Completed dispatches, newest first, one row per branch.
 *
 * Every plan revision is offered, not just the current one: a brief that was
 * re-dispatched got a fresh branch and the earlier one still exists on disk
 * with real work on it. Which of the two is wanted is the operator's call.
 */
export function mergeReviewRows(cfg: PublicRavelConfig): MergeReviewRow[] {
  const titles = new Map((cfg.plan?.briefs ?? []).map((brief) => [brief.id, brief.title]))
  const seen = new Set<string>()
  const rows: MergeReviewRow[] = []
  for (const dispatch of [...cfg.dispatches].sort((a, b) => b.startedAt - a.startedAt)) {
    if (dispatch.status !== 'completed' || seen.has(dispatch.branch)) continue
    seen.add(dispatch.branch)
    rows.push({
      briefId: dispatch.briefId,
      branch: dispatch.branch,
      title: titles.get(dispatch.briefId) ?? dispatch.briefId,
      planRevision: dispatch.planRevision,
      startedAt: dispatch.startedAt
    })
  }
  return rows
}

/**
 * Landing is never blocked on a bad preview: `mergeBranch` aborts and restores
 * the repo on failure, so attempting a merge the preview dislikes costs nothing
 * but a refusal. The preview colours the row; it does not veto it.
 */
export function reviewRowState(
  entry: MergePreviewEntry | undefined,
  landed: LandedRecord | undefined,
  deleted: boolean
): MergeReviewState {
  const severity = reviewSeverity(entry, landed, deleted)
  return {
    severity,
    ...SEVERITY_STYLE[severity],
    canLand: landed === undefined && !deleted,
    canDelete: landed !== undefined && !landed.squashed && !deleted
  }
}

function reviewSeverity(
  entry: MergePreviewEntry | undefined,
  landed: LandedRecord | undefined,
  deleted: boolean
): MergeReviewSeverity {
  if (deleted) return 'deleted'
  if (landed !== undefined) return 'landed'
  if (entry === undefined) return 'unchecked'
  // `conflictsWithBase: null` means the trial merge never ran. Reporting that as
  // "clean" would be a lie the operator acts on.
  if (entry.error !== null || entry.conflictsWithBase === null) return 'unknown'
  if (entry.conflictsWithBase) return 'conflict'
  return entry.overlaps.length > 0 ? 'overlap' : 'clean'
}

/**
 * Overlap is the intersection of changed files, not a trial merge. Two branches
 * touching one path usually collide but need not, so the wording warns and
 * never asserts.
 */
export function overlapSummary(entry: MergePreviewEntry): string | null {
  if (entry.overlaps.length === 0) return null
  const detail = entry.overlaps
    .map((overlap) => `${overlap.branch} (${plural(overlap.files.length, 'file')})`)
    .join(', ')
  return `Shares changed files with ${detail}. Heuristic warning from overlapping paths, not a trial merge.`
}

/**
 * `restored` is re-read from the repository after the recovery ran, so this is
 * the one place the operator is told what actually happened. Never claim a
 * clean repository on an exit code alone: the whole point of a non-destructive
 * merge is that the claim can be trusted.
 */
export function mergeFailureSummary(failure: MergeFailure): string {
  const paths = failure.paths?.length ? ` Git reported: ${failure.paths.join(', ')}.` : ''
  const state = failure.restored
    ? 'The repository is back where it started.'
    : 'The repository could NOT be confirmed back where it started — check HEAD, the current branch, the index and any merge in progress before doing anything else.'
  return `${failure.error}. ${state}${paths}`
}

export function landedSummary(record: LandedRecord): string {
  const { result } = record
  if (result.alreadyMerged) return `${result.branch} was already contained in the base branch.`
  const commit = result.commit === null ? '' : ` as ${result.commit.slice(0, 8)}`
  const how = record.squashed ? 'Squashed' : 'Merged'
  return `${how} ${plural(result.files.length, 'file')}${commit}.`
}

const MAX_LISTED_PATHS = 12

/**
 * Branches routinely touch more paths than a rail this narrow can show. The
 * count is always honest even when the list is not exhaustive.
 */
export function clipPaths(paths: readonly string[], limit: number = MAX_LISTED_PATHS): string[] {
  if (paths.length <= limit) return [...paths]
  return [...paths.slice(0, limit), `+${paths.length - limit} more`]
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}
