// Pure view-model: turn a `review.diff` patch into renderable hunks, and map a
// file's status/content to badge labels + tones.
//
// No React, no I/O. The parser and the badge helpers are unit-testable and keep
// their output shapes stable so the Review screen can stay a dumb renderer: it
// only decides WHEN to query `review.diff` and which tone classes to paint.

import type { ReviewDiffContent, ReviewFileDiff } from '@ops/api-contract'
import type { Tone } from './events'

/** How a single unified-diff line is presented. */
export type DiffLineKind = 'add' | 'del' | 'context' | 'meta'

/**
 * One line of a parsed hunk. `oldNo`/`newNo` are null when the line does not
 * occupy that side: added lines carry no old number, deleted lines no new
 * number, and `meta` lines (preamble + the `\ No newline` marker) carry none.
 */
export interface DiffLine {
  kind: DiffLineKind
  text: string
  oldNo: number | null
  newNo: number | null
}

/**
 * A hunk: its `@@ ... @@` header (empty string for the leading preamble block)
 * and the classified lines within it.
 */
export interface DiffHunk {
  header: string
  lines: DiffLine[]
}

/** Matches a `@@ -a,b +c,d @@` header (the `,b`/`,d` counts are optional). */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/**
 * Parse a bounded unified-diff `patch` into renderable hunks. Lines before the
 * first `@@` header — the `diff --git`/`index`/`rename`/`---`/`+++` preamble —
 * are classified `meta` and grouped into a leading hunk whose `header` is `''`
 * (a pure rename with no content change yields just that block). The `\ No
 * newline at end of file` marker is also `meta`. An empty patch → `[]`.
 *
 * Line numbers are tracked from each header: a context line advances both the
 * old and new counters, a `+` line only the new one, a `-` line only the old
 * one, and `meta` lines neither.
 */
export function parseUnifiedDiff(patch: string): DiffHunk[] {
  if (patch === '') return []
  const raw = patch.split('\n')
  // A trailing newline splits into a stray empty element; real diff lines are
  // never the empty string (context is ` `, add `+`, del `-`), so dropping it is
  // safe and keeps a blank final context line from being invented.
  if (raw.length > 0 && raw[raw.length - 1] === '') raw.pop()

  const hunks: DiffHunk[] = []
  let preamble: DiffHunk | null = null
  let cur: DiffHunk | null = null
  let oldNo = 0
  let newNo = 0

  for (const line of raw) {
    const m = line.match(HUNK_HEADER)
    if (m) {
      oldNo = parseInt(m[1], 10)
      newNo = parseInt(m[3], 10)
      cur = { header: line, lines: [] }
      hunks.push(cur)
      continue
    }
    if (cur === null) {
      // Preamble before the first @@ → meta (covers --- / +++ too).
      if (preamble === null) preamble = { header: '', lines: [] }
      preamble.lines.push({ kind: 'meta', text: line, oldNo: null, newNo: null })
      continue
    }
    if (line.startsWith('+')) {
      cur.lines.push({ kind: 'add', text: line.slice(1), oldNo: null, newNo })
      newNo += 1
    } else if (line.startsWith('-')) {
      cur.lines.push({ kind: 'del', text: line.slice(1), oldNo, newNo: null })
      oldNo += 1
    } else if (line.startsWith(' ')) {
      cur.lines.push({ kind: 'context', text: line.slice(1), oldNo, newNo })
      oldNo += 1
      newNo += 1
    } else {
      // `\ No newline at end of file` (or any other marker) → meta, no advance.
      cur.lines.push({ kind: 'meta', text: line, oldNo: null, newNo: null })
    }
  }

  if (preamble !== null) hunks.unshift(preamble)
  return hunks
}

const STATUS_BADGE: Record<ReviewFileDiff['status'], { label: string; tone: Tone }> = {
  added: { label: 'added', tone: 'green' },
  deleted: { label: 'deleted', tone: 'red' },
  modified: { label: 'modified', tone: 'blue' },
  renamed: { label: 'renamed', tone: 'blue' }
}

/** The badge label + tone for a file's change status. Never throws. */
export function fileStatusBadge(
  status: ReviewFileDiff['status']
): { label: string; tone: Tone } {
  return STATUS_BADGE[status] ?? { label: status, tone: 'neutral' }
}

/**
 * The "not shown" note for a file whose diff is not renderable as text, or `null`
 * when the diff is plain text (render the parsed patch instead). The label is the
 * sentence the UI shows verbatim; the tone is amber for every non-text state so a
 * glance distinguishes "shown" from "deliberately not shown".
 */
export function fileContentNote(
  content: ReviewDiffContent
): { label: string; tone: Tone } | null {
  switch (content) {
    case 'binary':
      return { label: 'Binary file (not shown)', tone: 'amber' }
    case 'oversized':
      return { label: 'Diff too large to display', tone: 'amber' }
    case 'truncated':
      return { label: 'Not shown — review size limit reached', tone: 'amber' }
    default:
      return null
  }
}
