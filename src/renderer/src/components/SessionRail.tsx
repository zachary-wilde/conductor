import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store/useStore'
import { SessionCard } from './SessionCard'
import { X as CloseIcon } from 'lucide-react'

/**
 * Right rail: quick switcher for normal sessions. Rendered inside
 * `.workspace-shell`'s third grid column at wide viewports, or as a
 * controlled drawer (`open`) below 1100px — see index.css.
 */
export function SessionRail({
  open,
  onRequestClose
}: {
  open: boolean
  onRequestClose: () => void
}): JSX.Element {
  const allSessions = useStore((s) => s.sessions)
  // Filter in a memo (not inline in the selector) so the array reference is
  // stable across renders where the underlying session list didn't change —
  // selectors that `.filter()` inline allocate a new array every render.
  const sessions = useMemo(() => allSessions.filter((s) => s.kind === 'normal'), [allSessions])
  const selectedSessionId = useStore((s) => s.selectedSessionId)
  const view = useStore((s) => s.view)
  const openSession = useStore((s) => s.openSession)

  const listRef = useRef<HTMLDivElement>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const [focusedSessionId, setFocusedSessionId] = useState<string | null>(null)
  const wasOpen = useRef(open)

  // Keep the roving index pointed at the current session when it changes.
  useEffect(() => {
    if (sessions.length === 0) return
    const selectedIdx =
      view === 'session' ? sessions.findIndex((s) => s.id === selectedSessionId) : -1
    setActiveIndex(selectedIdx >= 0 ? selectedIdx : 0)
  }, [sessions, selectedSessionId, view])

  // `focusedSessionId` is cleared only by a real focus departure from the
  // list. Removing a focused row does not normally emit blur, leaving its id
  // as proof that the rail owns focus and should re-anchor it.
  useEffect(() => {
    if (!open || focusedSessionId === null) return
    if (sessions.some((s) => s.id === focusedSessionId)) return
    if (sessions.length === 0) {
      setFocusedSessionId(null)
      return
    }
    const nextIndex = Math.min(activeIndex, sessions.length - 1)
    setActiveIndex(nextIndex)
    setFocusedSessionId(sessions[nextIndex].id)
    focusRow(nextIndex)
  }, [sessions, open, focusedSessionId, activeIndex])

  // Only steal focus on a genuine closed->open transition (drawer opening),
  // never on mount when the rail starts permanently visible at wide widths.
  useEffect(() => {
    if (open && !wasOpen.current) {
      focusRow(activeIndex)
    }
    wasOpen.current = open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const focusRow = (idx: number): void => {
    const rows = listRef.current?.querySelectorAll<HTMLButtonElement>('[data-session-row]')
    rows?.[idx]?.focus()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (sessions.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      e.stopPropagation()
      const next = Math.min(activeIndex + 1, sessions.length - 1)
      setActiveIndex(next)
      focusRow(next)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      e.stopPropagation()
      const next = Math.max(activeIndex - 1, 0)
      setActiveIndex(next)
      focusRow(next)
    } else if (e.key === 'Home') {
      e.preventDefault()
      e.stopPropagation()
      setActiveIndex(0)
      focusRow(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      e.stopPropagation()
      const next = sessions.length - 1
      setActiveIndex(next)
      focusRow(next)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      const s = sessions[activeIndex]
      if (s) {
        openSession(s.id)
        onRequestClose()
      }
    }
  }

  const onBlurCapture = (event: React.FocusEvent<HTMLDivElement>): void => {
    const nextTarget = event.relatedTarget
    if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
      setFocusedSessionId(null)
    }
  }

  return (
    <div className="session-rail flex h-full flex-col">
      <div className="glass-divider flex items-center justify-between border-b px-3 py-3">
        <span className="label">Sessions</span>
        <button
          className="session-rail__close btn-ghost px-2 py-1"
          onClick={onRequestClose}
          title="Close sessions"
        >
          <CloseIcon size={14} />
        </button>
      </div>
      <div
        ref={listRef}
        role="list"
        aria-label="Sessions"
        className="min-h-0 flex-1 overflow-y-auto p-1.5"
        onKeyDown={onKeyDown}
        onBlurCapture={onBlurCapture}
      >
        {sessions.length === 0 ? (
          <p className="px-2 py-4 text-xs text-text-low">No sessions yet.</p>
        ) : (
          sessions.map((session, idx) => {
            const isSelected = view === 'session' && session.id === selectedSessionId
            return (
              <SessionCard
                key={session.id}
                session={session}
                compact
                selected={isSelected}
                dataSessionRow
                tabIndex={idx === activeIndex ? 0 : -1}
                onOpen={() => {
                  openSession(session.id)
                  onRequestClose()
                }}
                onFocus={() => {
                  setActiveIndex(idx)
                  setFocusedSessionId(session.id)
                }}
              />
            )
          })
        )}
      </div>
    </div>
  )
}
