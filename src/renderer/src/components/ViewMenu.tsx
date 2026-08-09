import { useEffect, useRef, useState } from 'react'
import { Check, Eye } from 'lucide-react'
import {
  PANEL_IDS,
  PANEL_LABELS,
  canvasPanelId,
  panelVisible,
  type CanvasPanelKind,
  type PanelId
} from '@shared/types'
import { useStore } from '../store/useStore'

interface WindowRow {
  id: string
  kind: CanvasPanelKind
  subjectId: string | null
  label: string
  /** Right-hand tag: what kind of thing this window shows. */
  typeLabel: string
}

function windowRow(
  kind: CanvasPanelKind,
  subjectId: string | null,
  label: string,
  typeLabel: string
): WindowRow {
  return { id: canvasPanelId(kind, subjectId), kind, subjectId, label, typeLabel }
}

const SINGLETON_WINDOWS: WindowRow[] = [
  windowRow('sessions', null, 'Sessions', 'Window'),
  windowRow('work', null, 'Work in flight', 'Window'),
  windowRow('fleet', null, 'Fleet', 'Window'),
  windowRow('settings', null, 'Settings', 'Window')
]

const FALLBACK_WINDOWS: Record<CanvasPanelKind, Pick<WindowRow, 'label' | 'typeLabel'>> = {
  sessions: { label: 'Sessions', typeLabel: 'Window' },
  work: { label: 'Work in flight', typeLabel: 'Window' },
  fleet: { label: 'Fleet', typeLabel: 'Window' },
  settings: { label: 'Settings', typeLabel: 'Window' },
  session: { label: 'Session', typeLabel: 'Session' },
  ravel: { label: 'Ravel', typeLabel: 'Ravel' },
  roundtable: { label: 'Roundtable', typeLabel: 'Roundtable' }
}

/** Shows and hides canvas windows without changing the work running inside them. */
export function ViewMenu(): JSX.Element {
  const panelParts = useStore((s) => s.settings.panels)
  const canvasPanels = useStore((s) => s.settings.canvas.panels)
  const sessions = useStore((s) => s.sessions)
  const ravels = useStore((s) => s.ravelList)
  const roundtables = useStore((s) => s.roundtables)
  const openPanel = useStore((s) => s.openPanel)
  const closePanel = useStore((s) => s.closePanel)
  const saveSettings = useStore((s) => s.saveSettings)
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const knownWindows: WindowRow[] = [
    ...SINGLETON_WINDOWS,
    ...sessions.map((session) =>
      windowRow(
        'session',
        session.id,
        session.title ?? session.branch,
        session.harness === null ? 'Terminal' : 'Session'
      )
    ),
    ...ravels.map((ravel) => windowRow('ravel', ravel.id, ravel.name, 'Ravel')),
    ...roundtables.map((roundtable) =>
      windowRow('roundtable', roundtable.id, roundtable.name, 'Roundtable')
    )
  ]
  const knownIds = new Set(knownWindows.map((row) => row.id))
  const windows = [
    ...knownWindows,
    ...canvasPanels
      .filter((panel) => !knownIds.has(panel.id))
      .map((panel) => ({
        id: panel.id,
        kind: panel.kind,
        subjectId: panel.subjectId,
        ...FALLBACK_WINDOWS[panel.kind]
      }))
  ]
  const openIds = new Set(canvasPanels.map((panel) => panel.id))

  const togglePart = (id: PanelId): void => {
    const next = { ...panelParts }
    if (panelVisible(panelParts, id)) next[id] = false
    else delete next[id]
    void saveSettings({ panels: next })
  }

  return (
    <div className="relative" ref={boxRef} style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
      <button
        data-testid="view-menu"
        className="flex h-8 items-center gap-1.5 px-2.5 font-mono text-[10px] uppercase tracking-wider hover:bg-[var(--glass-hover)] hover:text-text-hi"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Eye size={12} /> View
      </button>
      {open && (
        <div
          className="glass-panel absolute right-0 top-8 z-50 max-h-[70vh] w-72 overflow-y-auto p-1"
          role="menu"
        >
          <div role="group" aria-labelledby="view-canvas-windows-heading">
            <p
              id="view-canvas-windows-heading"
              className="px-2 pb-1 pt-1.5 font-mono text-[9px] uppercase tracking-[0.12em] text-text-hint"
            >
              Canvas windows
            </p>
          {windows.map((row) => {
            const shown = openIds.has(row.id)
            return (
              <button
                key={row.id}
                type="button"
                role="menuitemcheckbox"
                aria-checked={shown}
                data-testid={`view-window-${row.id}`}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-text-mid hover:bg-[var(--glass-hover)] hover:text-text-hi"
                onClick={() =>
                  shown ? closePanel(row.id) : openPanel(row.kind, row.subjectId)
                }
              >
                <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-accent">
                  {shown ? <Check size={12} /> : null}
                </span>
                <span className="min-w-0 flex-1 truncate">{row.label}</span>
                <span className="shrink-0 font-mono text-[9px] uppercase text-text-hint">
                  {row.typeLabel}
                </span>
              </button>
            )
          })}
          </div>

          <div role="separator" className="mx-1 my-1 border-t glass-divider" />
          <div role="group" aria-labelledby="view-workspace-parts-heading">
            <p
              id="view-workspace-parts-heading"
              className="px-2 pb-1 pt-1.5 font-mono text-[9px] uppercase tracking-[0.12em] text-text-hint"
            >
              Workspace parts
            </p>
          {PANEL_IDS.map((id) => {
            const shown = panelVisible(panelParts, id)
            return (
              <button
                key={id}
                role="menuitemcheckbox"
                aria-checked={shown}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-text-mid hover:bg-[var(--glass-hover)] hover:text-text-hi"
                onClick={() => togglePart(id)}
              >
                <span className="flex h-3.5 w-3.5 items-center justify-center text-accent">
                  {shown ? <Check size={12} /> : null}
                </span>
                {PANEL_LABELS[id]}
              </button>
            )
          })}
          </div>
        </div>
      )}
    </div>
  )
}
