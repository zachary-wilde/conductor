import React, { lazy, Suspense, useEffect, useRef } from 'react'
import { FolderPlus, Gauge, Grid2x2, MessageCircle, Sparkles, SlidersHorizontal, TerminalSquare } from 'lucide-react'
import type { CanvasPanel, CanvasPanelKind } from '@shared/types'
import type { CanvasViewport, Rect } from '../lib/canvas'
import { useStore } from '../store/useStore'
import { CanvasFrame } from './CanvasFrame'
import { Dock } from './Dock'
import { SessionsPanel, WorkPanel, FleetMeter } from './CanvasPanels'
import { HarnessStatus } from './HarnessStatus'

const SessionView = lazy(() => import('./SessionView').then((m) => ({ default: m.SessionView })))
const RavelView = lazy(() => import('./RavelView').then((m) => ({ default: m.RavelView })))
const RoundtableView = lazy(() =>
  import('./RoundtableView').then((m) => ({ default: m.RoundtableView }))
)
const SettingsView = lazy(() => import('./SettingsView').then((m) => ({ default: m.SettingsView })))

/**
 * The workspace: every view is a floating panel on one canvas.
 *
 * Opening a session or a ravel used to swap the whole shell for a docked
 * three-column layout, which read as a different application. Panels keep their
 * position and size, so the arrangement is the operator's, not the router's.
 */

const ICON: Record<CanvasPanelKind, JSX.Element> = {
  sessions: <TerminalSquare size={11} className="text-text-low" />,
  work: <Grid2x2 size={11} className="text-text-low" />,
  fleet: <Gauge size={11} className="text-text-low" />,
  session: <TerminalSquare size={11} className="text-text-low" />,
  ravel: <Sparkles size={11} className="text-text-low" />,
  roundtable: <MessageCircle size={11} className="text-text-low" />,
  settings: <SlidersHorizontal size={11} className="text-text-low" />
}

function usePanelTitle(panel: CanvasPanel): string {
  const sessions = useStore((s) => s.sessions)
  const ravels = useStore((s) => s.ravelList)
  const roundtables = useStore((s) => s.roundtables)

  switch (panel.kind) {
    case 'sessions':
      return 'Sessions'
    case 'work':
      return 'Work in flight'
    case 'fleet':
      return 'Fleet'
    case 'settings':
      return 'Settings'
    case 'session': {
      const session = sessions.find((item) => item.id === panel.subjectId)
      return session?.title ?? session?.branch ?? 'Session'
    }
    case 'ravel':
      return ravels.find((item) => item.id === panel.subjectId)?.name ?? 'Ravel'
    case 'roundtable':
      return roundtables.find((item) => item.id === panel.subjectId)?.name ?? 'Roundtable'
  }
}

function PanelBody({ panel }: { panel: CanvasPanel }): JSX.Element {
  const subject = panel.subjectId ?? undefined
  switch (panel.kind) {
    case 'sessions':
      return <SessionsPanel />
    case 'work':
      return <WorkPanel />
    case 'fleet':
      return <FleetMeter />
    case 'session':
      // The document workspace is provided once at the app level (keyed by
      // sessionId), so every session panel is isolated without its own provider.
      return <SessionView sessionId={subject} />
    case 'ravel':
      return <RavelView ravelId={subject} />
    case 'roundtable':
      return <RoundtableView roundtableId={subject} />
    case 'settings':
      return <SettingsView />
  }
}

export function Canvas(): JSX.Element {
  const panels = useStore((s) => s.settings.canvas.panels)
  const sessions = useStore((s) => s.sessions)
  const ravels = useStore((s) => s.ravelList)
  const roundtables = useStore((s) => s.roundtables)
  const viewport = useStore((s) => s.canvasViewport)
  const raisePanel = useStore((s) => s.raisePanel)
  const closePanel = useStore((s) => s.closePanel)
  const togglePanelMinimized = useStore((s) => s.togglePanelMinimized)
  const setPanelGeometry = useStore((s) => s.setPanelGeometry)
  const initializeCanvas = useStore((s) => s.initializeCanvas)
  const reflowCanvas = useStore((s) => s.reflowCanvas)
  const repos = useStore((s) => s.repos)
  const addRepo = useStore((s) => s.addRepo)
  const harnesses = useStore((s) => s.harnesses)
  const surface = useRef<HTMLDivElement>(null)
  const measuredOnce = useRef(false)

  // Initialize only after the first real measurement. Later resize callbacks
  // re-home panels saved on a larger viewport without reseeding the canvas.
  useEffect(() => {
    const element = surface.current
    if (element === null) return
    const measure = (): void => {
      const width = element.clientWidth
      const height = element.clientHeight
      if (!measuredOnce.current) {
        measuredOnce.current = true
        initializeCanvas(width, height)
      } else {
        reflowCanvas(width, height)
      }
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [initializeCanvas, reflowCanvas])

  const pickRepo = async (): Promise<void> => {
    const p = await window.api.pickDirectory()
    if (p) await addRepo(p)
  }

  // Split panels: minimized go to the dock, non-minimized stay on the canvas
  const visiblePanels = panels.filter((p) => !p.minimized)
  const minimizedPanels = panels.filter((p) => p.minimized)
  const frontmost = visiblePanels.reduce<number>((top, panel) => Math.max(top, panel.z), 0)

  return (
    // `absolute inset-0`, not `flex-1`: the wrapper is a positioned block, not a
    // flex container, so a flex basis here resolves to zero height and clips
    // every panel away.
    <div ref={surface} data-testid="canvas" className="absolute inset-0 overflow-hidden">
      {viewport !== null && visiblePanels.map((panel) => (
        <CanvasFrameFor
          key={panel.id}
          panel={panel}
          viewport={viewport}
          active={panel.z === frontmost}
          onRaise={() => raisePanel(panel.id)}
          onClose={() => closePanel(panel.id)}
          onMinimize={() => togglePanelMinimized(panel.id)}
          onGeometry={(rect) => setPanelGeometry(panel.id, rect)}
        />
      ))}
      {repos.length === 0 && (
        <div
          data-testid="no-repos-empty-state"
          className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center"
        >
          <div className="glass-panel pointer-events-auto flex w-full max-w-sm flex-col items-center gap-4 rounded-2xl px-8 py-7 text-center">
            <h2 className="text-lg font-semibold">Add a repository to begin</h2>
            <p className="text-sm text-text-low">
              Sessions, Ravels, and terminals each run inside a git repository. Add one to start
              commanding agents.
            </p>
            <button
              type="button"
              data-testid="add-repository"
              onClick={pickRepo}
              className="btn-primary flex items-center gap-1.5 px-4 py-2 text-sm"
            >
              <FolderPlus size={15} /> Add a repository
            </button>
            <HarnessStatus harnesses={harnesses} />
          </div>
        </div>
      )}
      <Dock
        panels={minimizedPanels}
        sessions={sessions}
        ravels={ravels}
        roundtables={roundtables}
        onRestore={(id) => togglePanelMinimized(id)}
        onClose={(id) => closePanel(id)}
      />
    </div>
  )
}

function CanvasFrameFor({
  panel,
  viewport,
  active,
  onRaise,
  onClose,
  onMinimize,
  onGeometry
}: {
  panel: CanvasPanel
  viewport: CanvasViewport
  active: boolean
  onRaise: () => void
  onClose: () => void
  onMinimize: () => void
  onGeometry: (rect: Rect) => void
}): JSX.Element {
  const title = usePanelTitle(panel)
  return (
    <CanvasFrame
      panel={panel}
      viewport={viewport}
      title={title}
      icon={ICON[panel.kind]}
      active={active}
      onRaise={onRaise}
      onClose={onClose}
      onMinimize={onMinimize}
      onGeometry={onGeometry}
    >
      <Suspense fallback={<div className="h-full w-full" />}>
        <PanelBody panel={panel} />
      </Suspense>
    </CanvasFrame>
  )
}
