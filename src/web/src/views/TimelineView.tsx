// Timeline screen — the live unified event stream. The home screen. Events
// arrive folded by the shared timeline context; here they are grouped into
// consecutive same-kind runs so the stream reads as labelled sections, newest
// at the bottom (auto-scrolled into view).

import { useEffect, useRef } from 'react'
import { useTimeline } from '../state/timeline'
import { groupByKind, kindMeta, toneChip } from '../viewmodel/events'
import { Badge, EmptyState, Notice } from '../components/ui'
import { EventRow } from '../components/EventRow'

export function TimelineView(): JSX.Element {
  const { state, status } = useTimeline()
  const bottomRef = useRef<HTMLDivElement | null>(null)

  // Keep the newest event in view as the stream tails, but only when the user is
  // already near the bottom (so scrolling up to read history is not fought).
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160
    if (nearBottom) bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [state.events.length])

  const groups = groupByKind(state.events)

  return (
    <div ref={scrollerRef} className="scroll-thin flex-1 overflow-y-auto">
      {status === 'offline' ? (
        <div className="px-4 pt-3">
          <Notice tone="error">
            Lost the live stream. The client retries automatically; if this persists, the core may
            have stopped.
          </Notice>
        </div>
      ) : null}
      {status === 'resyncing' ? (
        <div className="px-4 pt-3">
          <Notice tone="warn">Re-syncing history after a journal rotation…</Notice>
        </div>
      ) : null}

      {groups.length === 0 ? (
        <div className="px-4 py-10">
          <EmptyState
            title="No events yet"
            body="Worker lifecycle, tool calls, commits, and approvals will stream here as soon as the fleet is active."
          />
        </div>
      ) : (
        <div>
          {groups.map((group, i) => {
            const meta = kindMeta(group.kind)
            return (
              <section key={`${group.kind}-${i}`}>
                <div className="sticky top-0 z-[1] flex items-center gap-2 border-b border-edge bg-bg-0/90 px-4 py-1.5 backdrop-blur">
                  <Badge className={toneChip(meta.tone)}>{meta.label}</Badge>
                  <span className="font-mono text-[10px] text-text-hint">
                    {group.events.length}
                  </span>
                </div>
                <div className="divide-y divide-edge/40">
                  {group.events.map((ev) => (
                    <EventRow key={ev.id} ev={ev} />
                  ))}
                </div>
              </section>
            )
          })}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  )
}
