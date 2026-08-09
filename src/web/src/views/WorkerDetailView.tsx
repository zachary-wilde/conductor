// Worker detail screen. Queries `worker.detail`, renders the control-plane
// projection + recent events, and issues `worker.control` commands. Destructive
// actions (stop/detach/archive) gate on an explicit confirm step and send
// `confirmed:true`; `message` opens a composer. Every command is disabled while
// the core is read-only (incompatible handshake).

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { ChevronLeft, Send } from 'lucide-react'
import type { WorkerDetailView as WorkerDetail } from '@ops/api-contract'
import type { WorkerControlAction } from '@ops/worker-controls'
import { requiresConfirmation } from '@ops/worker-controls'
import { useCore } from '../state/coreContext'
import { workerControl } from '../viewmodel/commands'
import { detachConfirmCopy, type DetachConfirmCopy } from '../viewmodel/detachConfirm'
import { Badge, Button, Notice, Spinner, TextArea } from '../components/ui'
import { EventRow } from '../components/EventRow'

type BtnVariant = 'primary' | 'ghost' | 'danger' | 'success'

const ACTION_META: Record<WorkerControlAction, { label: string; variant: BtnVariant }> = {
  message: { label: 'Send message', variant: 'primary' },
  pause: { label: 'Pause', variant: 'ghost' },
  resume: { label: 'Resume', variant: 'success' },
  stop: { label: 'Stop', variant: 'danger' },
  retry: { label: 'Retry', variant: 'ghost' },
  archive: { label: 'Archive', variant: 'danger' },
  detach: { label: 'Detach', variant: 'danger' }
}

interface Feedback {
  tone: 'info' | 'error'
  text: string
}

export function WorkerDetailView({
  workerId,
  onBack
}: {
  workerId: string
  onBack: () => void
}): JSX.Element {
  const { client, compatible } = useCore()
  const [detail, setDetail] = useState<WorkerDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [queryError, setQueryError] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [pending, setPending] = useState<WorkerControlAction | null>(null)
  const [confirming, setConfirming] = useState<WorkerControlAction | null>(null)
  const [feedback, setFeedback] = useState<Feedback | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    setQueryError(null)
    client
      .query({ name: 'worker.detail', workerId })
      .then((d) => {
        setDetail(d)
        setLoading(false)
      })
      .catch((e: unknown) => {
        setQueryError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      })
  }, [client, workerId])

  useEffect(() => load(), [load])

  async function run(
    action: WorkerControlAction,
    opts: { message?: string; confirmed?: boolean }
  ): Promise<void> {
    if (!compatible) return
    setPending(action)
    setFeedback(null)
    try {
      const res = await client.command(workerControl(workerId, action, opts))
      if (res.ok) {
        setFeedback({ tone: 'info', text: `${ACTION_META[action].label} accepted.` })
        setMessage('')
        load()
      } else {
        setFeedback({
          tone: 'error',
          text: `${ACTION_META[action].label} refused: ${res.error?.message ?? res.error?.code ?? 'unknown'}`
        })
      }
    } catch (e: unknown) {
      setFeedback({
        tone: 'error',
        text: `${ACTION_META[action].label} failed: ${e instanceof Error ? e.message : String(e)}`
      })
    } finally {
      setPending(null)
      setConfirming(null)
    }
  }

  const controls = detail ? detail.availableControls : []
  const canMessage = controls.includes('message')
  const otherControls = controls.filter((a) => a !== 'message')

  return (
    <div className="flex flex-col gap-4">
      <button
        onClick={onBack}
        className="inline-flex w-fit items-center gap-1 text-xs text-text-low transition-colors hover:text-text-hi"
      >
        <ChevronLeft size={14} /> Workers
      </button>

      <div className="flex flex-wrap items-center gap-2">
        <h1 className="font-mono text-sm text-text-hi">{workerId}</h1>
        {detail ? (
          <Badge className="bg-bg-3 text-text-mid">{detail.controlState.lifecycle}</Badge>
        ) : null}
      </div>

      {!compatible ? (
        <Notice tone="warn">
          The core reports an incompatible protocol — controls are disabled (read-only).
        </Notice>
      ) : null}

      {loading ? (
        <div className="flex items-center gap-2 py-6 text-text-low">
          <Spinner /> loading worker detail…
        </div>
      ) : queryError ? (
        <Notice tone="error">
          Could not load worker detail: {queryError}
          <button onClick={load} className="ml-2 underline">
            retry
          </button>
        </Notice>
      ) : detail ? (
        <>
          <section className="rounded-lg border border-edge bg-bg-1 p-3">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-low">
              Control state
            </h2>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 font-mono text-[11px] text-text-mid sm:grid-cols-3">
              <Stat k="kind">{detail.controlState.kind}</Stat>
              <Stat k="lifecycle">{detail.controlState.lifecycle}</Stat>
              <Stat k="response">
                {detail.controlState.responseInFlight ? 'in flight' : 'idle'}
              </Stat>
              <Stat k="dependents">{detail.controlState.dependentCount}</Stat>
              <Stat k="parent ravel">
                {detail.controlState.hasParentRavel ? 'yes' : 'no'}
              </Stat>
            </dl>
          </section>

          {canMessage ? (
            <section className="flex flex-col gap-2 rounded-lg border border-edge bg-bg-1 p-3">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-text-low">
                Message
              </h2>
              <TextArea
                rows={3}
                placeholder="Follow-up instruction for this worker…"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
              <Button
                variant="primary"
                disabled={!compatible || message.trim().length === 0 || pending !== null}
                onClick={() => run('message', { message: message.trim() })}
              >
                {pending === 'message' ? <Spinner /> : <Send size={14} />}
                Send message
              </Button>
            </section>
          ) : null}

          {otherControls.length > 0 ? (
            <section className="flex flex-col gap-2 rounded-lg border border-edge bg-bg-1 p-3">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-text-low">
                Controls
              </h2>
              <div className="flex flex-wrap gap-2">
                {otherControls.map((action) => {
                  const meta = ACTION_META[action]
                  const needsConfirm = requiresConfirmation(action, detail.controlState)
                  const isConfirming = confirming === action
                  // Detach renders its OWN labeled confirmation panel below this
                  // row — it must name the dependent briefs it blocks, so it never
                  // falls through to the generic unlabeled inline confirm that
                  // stop/archive reuse.
                  if (action === 'detach') {
                    return (
                      <Button
                        key={action}
                        disabled={pending !== null}
                        aria-expanded={isConfirming}
                        onClick={() => (needsConfirm ? setConfirming('detach') : run('detach', {}))}
                      >
                        {pending === 'detach' ? <Spinner /> : null}
                        {meta.label}
                      </Button>
                    )
                  }
                  if (isConfirming) {
                    return (
                      <span
                        key={action}
                        className="flex items-center gap-2 rounded-md border border-[rgb(var(--warn))]/30 bg-[rgb(var(--warn))]/10 px-2 py-1"
                      >
                        <span className="text-xs text-[rgb(var(--warn))]">Confirm {meta.label}?</span>
                        <Button
                          variant="danger"
                          disabled={pending !== null}
                          onClick={() => run(action, { confirmed: true })}
                        >
                          {pending === action ? <Spinner /> : null}
                          Confirm
                        </Button>
                        <Button variant="ghost" disabled={pending !== null} onClick={() => setConfirming(null)}>
                          Cancel
                        </Button>
                      </span>
                    )
                  }
                  return (
                    <Button
                      onClick={() =>
                        needsConfirm ? setConfirming(action) : run(action, {})
                      }
                    >
                      {pending === action ? <Spinner /> : null}
                      {meta.label}
                    </Button>
                  )
                })}
              </div>
            </section>
          ) : null}

          {confirming === 'detach' && detail ? (
            <DetachConfirmPanel
              copy={detachConfirmCopy(detail.dependentBriefs)}
              pending={pending === 'detach'}
              onConfirm={() => run('detach', { confirmed: true })}
              onCancel={() => setConfirming(null)}
            />
          ) : null}

          {feedback ? (
            <Notice tone={feedback.tone === 'error' ? 'error' : 'info'}>{feedback.text}</Notice>
          ) : null}

          <section className="flex flex-col gap-1">
            <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-text-low">
              Recent events
            </h2>
            {detail.latestEvents.length === 0 ? (
              <p className="text-xs text-text-hint">No events recorded for this worker.</p>
            ) : (
              <div className="divide-y divide-edge/40 rounded-lg border border-edge bg-bg-1">
                {detail.latestEvents.slice(-12).map((ev) => (
                  <EventRow key={ev.id} ev={ev} />
                ))}
              </div>
            )}
          </section>
        </>
      ) : null}
    </div>
  )
}

function Stat({ k, children }: { k: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col">
      <dt className="text-[10px] uppercase tracking-wide text-text-hint">{k}</dt>
      <dd className="text-text-mid">{children}</dd>
    </div>
  )
}

function DetachConfirmPanel({
  copy,
  pending,
  onConfirm,
  onCancel
}: {
  copy: DetachConfirmCopy
  pending: boolean
  onConfirm: () => void
  onCancel: () => void
}): JSX.Element {
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-[rgb(var(--warn))]/30 bg-[rgb(var(--warn))]/5 p-3">
      <div className="flex flex-col gap-2">
        <Notice tone={copy.hasDependents ? 'warn' : 'info'}>{copy.intro}</Notice>
        {copy.hasDependents ? (
          <ul className="flex flex-col gap-1">
            {copy.dependentBriefs.map((title, i) => (
              <li key={`${i}-${title}`} className="flex items-start gap-2 text-xs text-text-mid">
                <span className="mt-px text-[rgb(var(--warn))]">•</span>
                <span className="break-words">{title}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <p className="text-xs text-text-hint">{copy.effect}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="danger" disabled={pending} onClick={onConfirm}>
          {pending ? <Spinner /> : null}
          Confirm detach
        </Button>
        <Button variant="ghost" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </section>
  )
}
