import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Minus, X } from 'lucide-react'
import { CANVAS_HEADER_H, type CanvasPanel } from '@shared/types'
import {
  moveRect,
  resizeRect,
  type CanvasViewport,
  type Rect,
  type ResizeEdge
} from '../lib/canvas'

/**
 * One floating panel on the glass canvas: drag by the header, resize from the
 * edges and corners, raise on focus.
 *
 * Geometry is committed to the store only when a gesture ENDS. Persisting per
 * frame would write to disk on every pointer move, and the store's atomic write
 * is a temp file plus a rename — a drag would be hundreds of them.
 */

const HANDLES: { edge: ResizeEdge; className: string }[] = [
  { edge: 'n', className: 'left-2 right-2 top-0 h-1.5 cursor-ns-resize' },
  { edge: 's', className: 'left-2 right-2 bottom-0 h-1.5 cursor-ns-resize' },
  { edge: 'w', className: 'top-2 bottom-2 left-0 w-1.5 cursor-ew-resize' },
  { edge: 'e', className: 'top-2 bottom-2 right-0 w-1.5 cursor-ew-resize' },
  { edge: 'nw', className: 'left-0 top-0 h-3 w-3 cursor-nwse-resize' },
  { edge: 'ne', className: 'right-0 top-0 h-3 w-3 cursor-nesw-resize' },
  { edge: 'sw', className: 'left-0 bottom-0 h-3 w-3 cursor-nesw-resize' },
  { edge: 'se', className: 'right-0 bottom-0 h-3 w-3 cursor-nwse-resize' }
]

export function CanvasFrame({
  panel,
  viewport,
  title,
  active,
  icon,
  children,
  onGeometry,
  onRaise,
  onMinimize,
  onClose
}: {
  panel: CanvasPanel
  viewport: CanvasViewport
  title: string
  active: boolean
  icon?: ReactNode
  children: ReactNode
  /** Called once per gesture, on release. */
  onGeometry: (rect: Rect) => void
  onRaise: () => void
  onMinimize: () => void
  onClose: () => void
}): JSX.Element {
  const [draft, setDraft] = useState<Rect | null>(null)
  const gesture = useRef<{
    edge: ResizeEdge | 'move'
    startX: number
    startY: number
    rect: Rect
  } | null>(null)

  const rect: Rect = draft ?? { x: panel.x, y: panel.y, w: panel.w, h: panel.h }

  useEffect(() => {
    if (gesture.current === null) return
    const onMove = (event: MouseEvent): void => {
      const grab = gesture.current
      if (!grab) return
      const dx = event.clientX - grab.startX
      const dy = event.clientY - grab.startY
      setDraft(
        grab.edge === 'move'
          ? moveRect(grab.rect, dx, dy, viewport, false)
          : resizeRect(grab.rect, grab.edge, dx, dy, viewport)
      )
    }
    const onUp = (): void => {
      gesture.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      // Read the committed value from state rather than the closure: the last
      // mousemove may have landed after this handler was attached.
      setDraft((current) => {
        if (current !== null) onGeometry(current)
        return null
      })
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }, [draft, onGeometry, viewport])

  const begin = (edge: ResizeEdge | 'move') => (event: React.MouseEvent): void => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    onRaise()
    const start: Rect = { x: panel.x, y: panel.y, w: panel.w, h: panel.h }
    gesture.current = { edge, startX: event.clientX, startY: event.clientY, rect: start }
    document.body.style.cursor = edge === 'move' ? 'grabbing' : `${edge}-resize`
    document.body.style.userSelect = 'none'
    setDraft(start)
  }

  return (
    <section
      data-testid="canvas-panel"
      data-panel-kind={panel.kind}
      aria-label={title}
      onMouseDown={onRaise}
      className={`glass-panel absolute flex flex-col overflow-hidden ${
        active ? 'ring-1 ring-accent/40' : ''
      }`}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, zIndex: panel.z }}
    >
      <header
        onMouseDown={begin('move')}
        onDoubleClick={onMinimize}
        className="glass-bar flex shrink-0 cursor-grab items-center gap-2 border-b px-3 active:cursor-grabbing"
        style={{ height: CANVAS_HEADER_H }}
      >
        {icon}
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-[0.10em] text-text-hi">
          {title}
        </span>
        <button
          onClick={onMinimize}
          onMouseDown={(e) => e.stopPropagation()}
          aria-label="Minimize"
          className="grid h-[18px] w-[18px] place-items-center rounded-[5px] text-text-low hover:bg-white/[0.08] hover:text-text-hi"
        >
          <Minus size={11} />
        </button>
        <button
          onClick={onClose}
          onMouseDown={(e) => e.stopPropagation()}
          aria-label={`Close ${title}`}
          className="grid h-[18px] w-[18px] place-items-center rounded-[5px] text-text-low hover:bg-red-500/25 hover:text-text-hi"
        >
          <X size={11} />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>

      {HANDLES.map(({ edge, className }) => (
        <span
          key={edge}
          role="separator"
          aria-label={`Resize ${title} ${edge}`}
          onMouseDown={begin(edge)}
          className={`absolute z-10 ${className}`}
        />
      ))}
    </section>
  )
}
