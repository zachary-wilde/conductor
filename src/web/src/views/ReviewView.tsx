// Review screen. Lists the branches the core reports as reviewable
// (`review.list`) and lets the operator land / request changes / reject each
// one via `review.decide`. The commits, diff digest, and changed files come
// straight from the query item — nothing is hand-entered or recomputed
// client-side — so the only numbers that can be wrong are stale ones the core
// rechecks and refuses at land time (base/head/diff/verification/cleanliness).
//
// Landing an UNVERIFIED or FAILED branch is gated on an explicit confirm step
// (mirroring the core's `confirmed:true` rule, in `landRequiresConfirm`); a
// verified branch lands in one click. request-changes / reject carry a required
// operator note. Every action is disabled while the core is read-only
// (incompatible handshake).

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Eye, GitBranch, RotateCw } from 'lucide-react'
import type { ReviewDiff, ReviewFileDiff, ReviewListItem } from '@ops/api-contract'
import type { CoreClient } from '../api/client'
import { useCore } from '../state/coreContext'
import { reviewDecide } from '../viewmodel/commands'
import { landRequiresConfirm, verificationStatus } from '../viewmodel/review'
import type { VerificationStatus } from '../viewmodel/review'
import { toneChip } from '../viewmodel/events'
import type { Tone } from '../viewmodel/events'
import { fileContentNote, fileStatusBadge, parseUnifiedDiff } from '../viewmodel/diff'
import type { DiffLineKind } from '../viewmodel/diff'
import { Badge, Button, EmptyState, Notice, Spinner, TextArea } from '../components/ui'

type Decision = 'request-changes' | 'reject' | 'land'

interface Feedback {
  tone: 'info' | 'error'
  text: string
}

const VERIFY_TONE: Record<VerificationStatus, Tone> = {
  passed: 'green',
  failed: 'red',
  unverified: 'neutral'
}
const VERIFY_LABEL: Record<VerificationStatus, string> = {
  passed: 'verified',
  failed: 'verify failed',
  unverified: 'not verified'
}

export function ReviewView(): JSX.Element {
  const { client, compatible } = useCore()
  const [items, setItems] = useState<ReviewListItem[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [queryError, setQueryError] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    setQueryError(null)
    client
      .query({ name: 'review.list' })
      .then((list) => {
        setItems(list)
        setLoading(false)
      })
      .catch((e: unknown) => {
        setQueryError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      })
  }, [client])

  useEffect(() => load(), [load])

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <h1 className="text-sm font-semibold text-text-hi">Review</h1>
        <Button variant="ghost" className="ml-auto px-2 py-1 text-xs" disabled={loading} onClick={load}>
          {loading ? <Spinner /> : <RotateCw size={13} />}
          Refresh
        </Button>
      </div>

      {!compatible ? (
        <Notice tone="warn">Incompatible core — review decisions are read-only.</Notice>
      ) : null}

      {queryError ? (
        <Notice tone="error">Could not load branches to review: {queryError}</Notice>
      ) : null}

      {loading && items === null ? (
        <div className="flex items-center gap-2 py-6 text-text-low">
          <Spinner /> loading branches…
        </div>
      ) : !queryError && items !== null && items.length === 0 ? (
        <EmptyState title="No branches to review." />
      ) : items !== null ? (
        <div className="flex flex-col gap-3">
          {items.map((item) => (
            <ReviewCard
              key={`${item.repoId}\u0000${item.branch}`}
              item={item}
              client={client}
              compatible={compatible}
              onResolved={load}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function ReviewCard({
  item,
  client,
  compatible,
  onResolved
}: {
  item: ReviewListItem
  client: CoreClient
  compatible: boolean
  onResolved: () => void
}): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [note, setNote] = useState('')
  const [pending, setPending] = useState<Decision | null>(null)
  const [confirmingLand, setConfirmingLand] = useState(false)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [diffOpen, setDiffOpen] = useState(false)
  const [diff, setDiff] = useState<ReviewDiff | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState<string | null>(null)

  const status = verificationStatus(item.verification)
  const needsConfirm = landRequiresConfirm(item.verification)
  const noteReady = note.trim().length > 0
  const busy = pending !== null
  const loadDiff = useCallback(() => {
    setDiffOpen(true)
    setDiffLoading(true)
    setDiffError(null)
    client
      .query({ name: 'review.diff', repoId: item.repoId, branch: item.branch })
      .then((d) => {
        setDiff(d)
        setDiffLoading(false)
      })
      .catch((e: unknown) => {
        setDiffError(e instanceof Error ? e.message : String(e))
        setDiffLoading(false)
      })
  }, [client, item.repoId, item.branch])

  // The list item's digest was captured when `review.list` loaded; the diff
  // carries its own current digest. A mismatch means the branch moved under us —
  // surface it (the core re-checks at land time regardless), don't hide it.
  const stale = diff !== null && diff.diffDigest !== item.diffDigest

  async function run(
    decision: Decision,
    opts: { note?: string; confirmed?: boolean }
  ): Promise<void> {
    if (!compatible) return
    setPending(decision)
    setFeedback(null)
    try {
      const res = await client.command(
        reviewDecide({
          repoId: item.repoId,
          branch: item.branch,
          baseCommit: item.baseCommit,
          headCommit: item.headCommit,
          diffDigest: item.diffDigest,
          decision,
          note: opts.note,
          confirmed: opts.confirmed
        })
      )
      if (res.ok) {
        onResolved()
      } else {
        setFeedback({
          tone: 'error',
          text: `Refused: ${res.error?.message ?? res.error?.code ?? 'unknown'}`
        })
      }
    } catch (e: unknown) {
      setFeedback({
        tone: 'error',
        text: `Failed: ${e instanceof Error ? e.message : String(e)}`
      })
    } finally {
      setPending(null)
      setConfirmingLand(false)
    }
  }

  function onLand(): void {
    if (needsConfirm) {
      setConfirmingLand(true)
    } else {
      void run('land', { confirmed: true })
    }
  }
  function onToggleDiff(): void {
    if (diffOpen) setDiffOpen(false)
    else loadDiff()
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-edge bg-bg-1 p-3">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-text-hi">{item.title || item.branch}</p>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-text-hint">
            <span className="inline-flex items-center gap-1 font-mono text-text-mid">
              <GitBranch size={12} /> {item.branch}
            </span>
            <span>· {item.repoId}</span>
            <span className="font-mono">{item.headCommit.slice(0, 8)}</span>
            {!item.landable ? <span>· nothing to land</span> : null}
          </div>
        </div>
        <Badge className={toneChip(VERIFY_TONE[status])}>{VERIFY_LABEL[status]}</Badge>
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="inline-flex items-center gap-1 text-[11px] text-text-low transition-colors hover:text-text-hi"
          >
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            {item.changedFiles.length} file{item.changedFiles.length === 1 ? '' : 's'} changed
          </button>
          <button
            type="button"
            onClick={onToggleDiff}
            className="ml-auto inline-flex items-center gap-1 text-[11px] text-text-low transition-colors hover:text-text-hi"
          >
            <Eye size={12} />
            {diffOpen ? 'Hide diff' : 'View diff'}
          </button>
        </div>
        {expanded ? (
          <ul className="flex flex-col gap-0.5 rounded-md bg-bg-0 p-2">
            {item.changedFiles.length === 0 ? (
              <li className="text-[11px] text-text-hint">No changed files reported.</li>
            ) : (
              item.changedFiles.map((f) => (
                <li key={f} className="truncate font-mono text-[11px] text-text-mid">
                  {f}
                </li>
              ))
            )}
          </ul>
        ) : null}
      </div>
      {diffOpen ? (
        <div className="flex flex-col gap-2 rounded-md border border-edge bg-bg-0 p-2">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-text-hint">
            <span className="font-medium uppercase tracking-wide text-text-low">Diff</span>
            {diff ? (
              <>
                <span className="font-mono">{diff.baseBranch}</span>
                <span>
                  · {diff.baseCommit.slice(0, 8)} → {diff.headCommit.slice(0, 8)}
                </span>
              </>
            ) : null}
          </div>
          {stale ? (
            <Notice tone="warn">
              The branch changed since the list loaded.{' '}
              <button
                type="button"
                onClick={loadDiff}
                className="underline underline-offset-2 hover:text-text-hi"
              >
                Refresh diff
              </button>
            </Notice>
          ) : null}
          {diffLoading ? (
            <div className="flex items-center gap-2 py-2 text-text-low">
              <Spinner /> loading diff…
            </div>
          ) : diffError ? (
            <Notice tone="error">
              Could not load diff: {diffError}.{' '}
              <button
                type="button"
                onClick={loadDiff}
                className="underline underline-offset-2 hover:text-text-hi"
              >
                Retry
              </button>
            </Notice>
          ) : diff ? (
            <ReviewDiffBody diff={diff} />
          ) : null}
        </div>
      ) : null}

      <TextArea
        rows={2}
        placeholder="Note for request-changes / reject (required for those)…"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />

      {confirmingLand ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-[rgb(var(--warn))]/30 bg-[rgb(var(--warn))]/10 px-3 py-2">
          <span className="text-xs text-[rgb(var(--warn))]">
            {status === 'unverified'
              ? 'This branch was never verified — confirm landing it anyway?'
              : 'Verification failed — confirm landing it anyway?'}
          </span>
          <Button
            variant="success"
            className="ml-auto"
            disabled={busy}
            onClick={() => run('land', { confirmed: true })}
          >
            {pending === 'land' ? <Spinner /> : null}
            Confirm land
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => setConfirmingLand(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button variant="success" disabled={!compatible || busy} onClick={onLand}>
            {pending === 'land' ? <Spinner /> : null}
            Land
          </Button>
          <Button
            variant="primary"
            disabled={!compatible || busy || !noteReady}
            onClick={() => run('request-changes', { note: note.trim() })}
          >
            {pending === 'request-changes' ? <Spinner /> : null}
            Request changes
          </Button>
          <Button
            variant="danger"
            disabled={!compatible || busy || !noteReady}
            onClick={() => run('reject', { note: note.trim() })}
          >
            {pending === 'reject' ? <Spinner /> : null}
            Reject
          </Button>
        </div>
      )}

      {feedback ? <Notice tone={feedback.tone === 'error' ? 'error' : 'info'}>{feedback.text}</Notice> : null}
    </section>
  )
}

const DIFF_LINE_CLASS: Record<DiffLineKind, string> = {
  add: 'bg-accent-green/10 text-accent-green',
  del: 'bg-[rgb(var(--danger))]/10 text-[rgb(var(--danger))]',
  context: 'text-text-mid',
  meta: 'text-text-low'
}

function ReviewDiffBody({ diff }: { diff: ReviewDiff }): JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      {diff.files.map((f) => (
        <ReviewDiffFile key={f.path} file={f} />
      ))}
      {diff.truncated ? (
        <Notice tone="warn">Some files were omitted — review size limit reached.</Notice>
      ) : null}
    </div>
  )
}

function ReviewDiffFile({ file }: { file: ReviewFileDiff }): JSX.Element {
  const status = fileStatusBadge(file.status)
  const note = fileContentNote(file.content)
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 break-all font-mono text-[11px] text-text-hi">
          {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        </span>
        <Badge className={toneChip(status.tone)}>{status.label}</Badge>
        {file.additions !== null ? (
          <span className="font-mono text-[10px] text-accent-green">+{file.additions}</span>
        ) : null}
        {file.deletions !== null ? (
          <span className="font-mono text-[10px] text-[rgb(var(--danger))]">-{file.deletions}</span>
        ) : null}
      </div>
      {note ? (
        <p className="text-[11px] text-[rgb(var(--warn))]">{note.label}</p>
      ) : file.patch !== '' ? (
        <ReviewDiffPatch patch={file.patch} />
      ) : null}
    </div>
  )
}

function ReviewDiffPatch({ patch }: { patch: string }): JSX.Element {
  const hunks = useMemo(() => parseUnifiedDiff(patch), [patch])
  return (
    <pre className="scroll-thin overflow-x-auto rounded-md border border-edge bg-bg-0 p-2 font-mono text-[11px] leading-relaxed">
      {hunks.map((h, i) => (
        <div key={i} className={i > 0 ? 'mt-2' : ''}>
          {h.header !== '' ? <div className="text-accent-cyan">{h.header}</div> : null}
          {h.lines.map((ln, j) => (
            <div key={j} className={DIFF_LINE_CLASS[ln.kind]}>
              <span className="inline-block w-7 shrink-0 select-none pr-2 text-right opacity-50">
                {ln.oldNo ?? ''}
              </span>
              <span className="inline-block w-7 shrink-0 select-none pr-2 text-right opacity-50">
                {ln.newNo ?? ''}
              </span>
              <span className="whitespace-pre">{ln.text}</span>
            </div>
          ))}
        </div>
      ))}
    </pre>
  )
}
