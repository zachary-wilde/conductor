import { useEffect, useRef, useState } from 'react'
import { PANEL_SIZE_LIMITS, type ResizablePanelId } from '@shared/types'

/**
 * Drag divider between shell columns. Width tracks the pointer live via a
 * callback, and only the final value is persisted so a drag does not write to
 * the store on every frame.
 */
export function ResizeHandle({
  panel,
  width,
  edge,
  onPreview,
  onCommit,
  absoluteAt
}: {
  panel: ResizablePanelId
  width: number
  /** Which side of the panel the handle sits on. */
  edge: 'left' | 'right'
  onPreview: (next: number) => void
  onCommit: (next: number) => void
  /** Pin the handle to a seam instead of flowing it inline (grid layouts). */
  absoluteAt?: number
}): JSX.Element {
  const [dragging, setDragging] = useState(false)
  const latest = useRef(width)
  const start = useRef({ x: 0, width })

  useEffect(() => {
    if (!dragging) return
    const limits = PANEL_SIZE_LIMITS[panel]

    // Delta from where the drag began, not an absolute measurement against a
    // window edge: a rail is not always flush with one, and an absolute
    // reading makes the panel jump by whatever sits beside it on grab.
    const onMove = (event: MouseEvent): void => {
      const travelled = event.clientX - start.current.x
      const next = Math.min(
        limits.max,
        Math.max(limits.min, Math.round(start.current.width + (edge === 'right' ? travelled : -travelled)))
      )
      latest.current = next
      onPreview(next)
    }
    const onUp = (): void => {
      setDragging(false)
      onCommit(latest.current)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [dragging, edge, onCommit, onPreview, panel])

  const nudge = (delta: number): void => {
    const limits = PANEL_SIZE_LIMITS[panel]
    const next = Math.min(limits.max, Math.max(limits.min, width + delta))
    onPreview(next)
    onCommit(next)
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${panel} panel`}
      tabIndex={0}
      onMouseDown={(event) => {
        event.preventDefault()
        latest.current = width
        start.current = { x: event.clientX, width }
        setDragging(true)
      }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') nudge(edge === 'right' ? -16 : 16)
        if (event.key === 'ArrowRight') nudge(edge === 'right' ? 16 : -16)
      }}
      style={
        absoluteAt === undefined
          ? undefined
          : ({ '--seam-at': `${absoluteAt}px` } as React.CSSProperties)
      }
      className={`z-40 shrink-0 cursor-col-resize transition-colors hover:bg-accent/60 focus-visible:bg-accent/60 ${
        absoluteAt === undefined
          ? 'w-1.5'
          : `workspace-shell__seam workspace-shell__seam--${edge}`
      } ${dragging ? 'bg-accent/70' : 'bg-transparent'}`}
    />
  )
}
