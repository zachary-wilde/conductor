import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { X } from 'lucide-react'
import type { WorkerDetailView } from '@ops/api-contract'
import type { WorkerControlAction } from '@ops/worker-controls'
import { EventRow } from './EventRow'
import { Badge, Button } from './ui'

export type DetailsSheetWorker = Pick<WorkerDetailView, 'workerId' | 'controlState' | 'dependentBriefs'>

export interface DetailsSheetProps {
  open: boolean
  onClose: () => void
  worker: DetailsSheetWorker
  events: WorkerDetailView['latestEvents']
  controls: WorkerControlAction[]
  readOnly: boolean
  restoreFocusRef?: RefObject<HTMLElement | null>
}

/**
 * The worker details surface is deliberately a projection-only component. It
 * receives the same API projection already loaded by WorkerDetailView and does
 * not query or maintain a second worker state model.
 */
export function DetailsSheet({
  open,
  onClose,
  worker,
  events,
  controls,
  readOnly,
  restoreFocusRef
}: DetailsSheetProps): JSX.Element | null {
  const closeRef = useRef<HTMLButtonElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const wasOpenRef = useRef(false)

  useEffect(() => {
    if (!open) {
      if (wasOpenRef.current) {
        wasOpenRef.current = false
        const restoreTarget = restoreFocusRef?.current ?? previousFocusRef.current
        restoreTarget?.focus()
        previousFocusRef.current = null
      }
      return
    }

    if (!wasOpenRef.current) {
      wasOpenRef.current = true
      previousFocusRef.current = restoreFocusRef?.current ?? (document.activeElement as HTMLElement | null)
      closeRef.current?.focus()
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose, open, restoreFocusRef])

  useEffect(() => {
    return () => {
      if (!wasOpenRef.current) return
      const restoreTarget = restoreFocusRef?.current ?? previousFocusRef.current
      restoreTarget?.focus()
      wasOpenRef.current = false
      previousFocusRef.current = null
    }
  }, [restoreFocusRef])

  if (!open) return null

  return (
    <div className="pointer-events-auto absolute inset-0 z-20" data-testid="details-sheet-layer">
      <div
        aria-hidden="true"
        className="absolute inset-0 h-full w-full cursor-default bg-bg-0/60"
        onClick={onClose}
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="worker-details-title"
        className="absolute inset-x-0 bottom-0 flex max-h-[90%] flex-col overflow-hidden rounded-t-xl border border-edge bg-bg-1 shadow-2xl md:inset-y-0 md:left-auto md:right-0 md:w-[min(28rem,92%)] md:max-h-none md:rounded-l-xl md:rounded-t-none"
        style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-edge px-4 py-3">
          <div className="min-w-0">
            <h2 id="worker-details-title" className="text-sm font-semibold text-text-hi">
              Worker details
            </h2>
            <p className="truncate font-mono text-xs text-text-low">{worker.workerId}</p>
          </div>
          <Button
            ref={closeRef}
            type="button"
            variant="ghost"
            aria-label="Close worker details"
            className="shrink-0 px-2"
            onClick={onClose}
          >
            <X size={16} aria-hidden />
          </Button>
        </header>

        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-4">
          <div className="flex flex-col gap-4">
            <section aria-labelledby="details-control-state" className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <h3 id="details-control-state" className="text-xs font-semibold uppercase tracking-wide text-text-low">
                  Control state
                </h3>
                {readOnly ? <Badge className="bg-bg-3 text-text-hint">read-only</Badge> : null}
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border border-edge bg-bg-0/40 p-3 font-mono text-[11px] text-text-mid">
                <DetailStat label="kind">{worker.controlState.kind}</DetailStat>
                <DetailStat label="lifecycle">{worker.controlState.lifecycle}</DetailStat>
                <DetailStat label="response">{worker.controlState.responseInFlight ? 'in flight' : 'idle'}</DetailStat>
                <DetailStat label="dependents">{worker.controlState.dependentCount}</DetailStat>
                <DetailStat label="parent workflow">{worker.controlState.hasParentRavel ? 'yes' : 'no'}</DetailStat>
              </dl>
            </section>

            <section aria-labelledby="details-controls" className="flex flex-col gap-2">
              <h3 id="details-controls" className="text-xs font-semibold uppercase tracking-wide text-text-low">
                Available controls
              </h3>
              {controls.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {controls.map((control) => (
                    <Badge key={control} className="border border-edge bg-bg-2 text-text-mid">
                      {control}
                    </Badge>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-text-hint">No controls available.</p>
              )}
            </section>

            <section aria-labelledby="details-dependents" className="flex flex-col gap-2">
              <h3 id="details-dependents" className="text-xs font-semibold uppercase tracking-wide text-text-low">
                Dependent briefs
              </h3>
              {worker.dependentBriefs.length > 0 ? (
                <ul className="flex flex-col gap-1 rounded-lg border border-edge bg-bg-0/40 p-3 text-xs text-text-mid">
                  {worker.dependentBriefs.map((brief, index) => (
                    <li key={`${index}-${brief}`} className="break-words">
                      {brief}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-text-hint">No dependent briefs.</p>
              )}
            </section>

            <section aria-labelledby="details-events" className="flex flex-col gap-2">
              <h3 id="details-events" className="text-xs font-semibold uppercase tracking-wide text-text-low">
                Recent events
              </h3>
              {events.length > 0 ? (
                <div className="divide-y divide-edge/40 overflow-hidden rounded-lg border border-edge bg-bg-0/40">
                  {events.slice(-12).map((event) => <EventRow key={event.id} ev={event} />)}
                </div>
              ) : (
                <p className="text-xs text-text-hint">No events recorded for this worker.</p>
              )}
            </section>
          </div>
        </div>
      </section>
    </div>
  )
}

function DetailStat({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col">
      <dt className="text-[10px] uppercase tracking-wide text-text-hint">{label}</dt>
      <dd className="text-text-mid">{children}</dd>
    </div>
  )
}
