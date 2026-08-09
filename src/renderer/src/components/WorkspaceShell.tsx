import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { useStore } from '../store/useStore'
import { ProjectRail } from './ProjectRail'
import { SessionRail } from './SessionRail'
import { DocumentWorkspaceProvider } from './DocumentWorkspace'
import { MessageCircle, PanelRight, Sparkles } from 'lucide-react'
import { panelVisible, panelWidth } from '@shared/types'
import { ResizeHandle } from './ResizeHandle'
import type { PublicRavelConfig, RoundtableConfig } from '@shared/types'

/**
 * Renderer-local, unpersisted visibility state for the workspace shell's
 * three regions. None of this is app/store state — it never survives a
 * reload and never needs to.
 */
interface WorkspaceShellVisibility {
  /**
   * Reserved for a future collapsible-projects control; the project rail is
   * always rendered today (icon-only below 1100px via ProjectRail's own
   * `compact` prop). Kept in the shape now so a later responsive control can
   * wire into existing context/state instead of expanding this interface.
   */
  projectsOpen: boolean
  sessionsOpen: boolean
  /** Reserved for Task 5's inspector panel; not yet surfaced as UI. */
  inspectorOpen: boolean
}

interface WorkspaceShellContextValue extends WorkspaceShellVisibility {
  toggleSessions: (trigger?: HTMLElement | null) => void
  closeSessions: () => void
  toggleInspector: (trigger?: HTMLElement | null) => void
  closeInspector: () => void
}

const WorkspaceShellContext = createContext<WorkspaceShellContextValue | null>(null)

/**
 * Shell visibility, with a standalone default.
 *
 * A session rendered as a floating canvas panel has no surrounding shell to ask,
 * and its inspector is simply always available — so this returns a working value
 * instead of throwing. Throwing was right when the shell was the only way to
 * render a session; it is not any more.
 */
const STANDALONE: WorkspaceShellContextValue = {
  projectsOpen: false,
  sessionsOpen: false,
  inspectorOpen: true,
  toggleSessions: () => {},
  closeSessions: () => {},
  toggleInspector: () => {},
  closeInspector: () => {}
}

export function useWorkspaceShell(): WorkspaceShellContextValue {
  return useContext(WorkspaceShellContext) ?? STANDALONE
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const mql = window.matchMedia(query)
    const onChange = (): void => setMatches(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])
  return matches
}

/**
 * Ravel quick-access, owned by the shell (not ProjectRail): dense rows pinned at
 * the bottom of the project column so orchestration is never hidden in overflow.
 */
function RavelStrip({ compact }: { compact: boolean }): JSX.Element {
  const ravelList = useStore((s) => s.ravelList)
  const repos = useStore((s) => s.repos)
  const view = useStore((s) => s.view)
  const selectedRavelId = useStore((s) => s.selectedRavelId)
  const openRavel = useStore((s) => s.openRavel)
  const toggleNewRavel = useStore((s) => s.toggleNewRavel)
  const roundtables = useStore((s) => s.roundtables)
  const selectedRoundtableId = useStore((s) => s.selectedRoundtableId)
  const openRoundtable = useStore((s) => s.openRoundtable)
  const toggleNewRoundtable = useStore((s) => s.toggleNewRoundtable)

  const renderEntry = (ravel: PublicRavelConfig): JSX.Element => {
    const active = view === 'ravel' && selectedRavelId === ravel.id
    return (
      <button
        key={ravel.id}
        onClick={() => openRavel(ravel.id)}
        aria-current={active ? 'page' : undefined}
        data-testid="ravel-row"
        title={ravel.name}
        className={
          compact
            ? `glass-choice flex h-8 w-8 items-center justify-center ${
                active ? 'border-accent/60 bg-accent/[0.13] text-accent' : 'text-text-low'
              }`
            : `glass-choice flex w-full items-center gap-2 px-2 py-1.5 text-left ${
                active ? 'border-accent/60 bg-accent/[0.13] text-text-hi' : 'text-text-mid'
              }`
        }
      >
        <Sparkles
          size={13}
          className={`shrink-0 ${ravel.status === 'running' || ravel.status === 'awaiting-approval' ? 'text-success' : 'text-text-low'}`}
        />
        {!compact && <span className="min-w-0 flex-1 truncate text-xs">{ravel.name}</span>}
      </button>
    )
  }

  const renderRoundtableEntry = (roundtable: RoundtableConfig): JSX.Element => {
    const active = view === 'roundtable' && selectedRoundtableId === roundtable.id
    return (
      <button
        key={roundtable.id}
        onClick={() => openRoundtable(roundtable.id)}
        aria-current={active ? 'page' : undefined}
        title={roundtable.name}
        className={
          compact
            ? `glass-choice flex h-8 w-8 items-center justify-center ${
                active ? 'border-accent/60 bg-accent/[0.13] text-accent' : 'text-text-low'
              }`
            : `glass-choice flex w-full items-center gap-2 px-2 py-1.5 text-left ${
                active ? 'border-accent/60 bg-accent/[0.13] text-text-hi' : 'text-text-mid'
              }`
        }
      >
        <MessageCircle
          size={13}
          className={`shrink-0 ${roundtable.status === 'running' ? 'text-success' : 'text-text-low'}`}
        />
        {!compact && <span className="min-w-0 flex-1 truncate text-xs">{roundtable.name}</span>}
      </button>
    )
  }

  return (
    <div
      className={`glass-divider shrink-0 border-t py-2 ${
        compact ? 'flex flex-col items-center gap-1.5 px-0' : 'px-2'
      }`}
    >
      {!compact && <div className="mb-1 px-1 label">Ravel</div>}
      {ravelList.length > 0 && (
        <div className={`flex flex-col gap-1 ${compact ? 'items-center' : ''}`}>
          {ravelList.map(renderEntry)}
        </div>
      )}
      <button
        className={
          compact
            ? 'btn-outline mt-1.5 h-8 w-8 p-0'
            : 'btn-outline mt-2 w-full justify-start px-2'
        }
        onClick={() => toggleNewRavel(true)}
        disabled={repos.length === 0}
        data-testid="new-ravel"
        title={repos.length === 0 ? 'Add a repository first' : 'New Ravel orchestrator'}
      >
        <Sparkles size={13} />
        {!compact && 'New Ravel'}
      </button>
      {!compact && <div className="mb-1 mt-3 px-1 label">Roundtables</div>}
      {roundtables.length > 0 && (
        <div className={`flex flex-col gap-1 ${compact ? 'glass-divider mt-2 items-center border-t pt-2' : ''}`}>
          {roundtables.map(renderRoundtableEntry)}
        </div>
      )}
      <button
        className={
          compact
            ? 'btn-outline mt-1.5 h-8 w-8 p-0'
            : 'btn-outline mt-2 w-full justify-start px-2'
        }
        onClick={() => toggleNewRoundtable(true)}
        disabled={repos.length === 0}
        data-testid="new-roundtable"
        title={repos.length === 0 ? 'Add a repository first' : 'New Roundtable'}
        aria-label={compact ? 'New Roundtable' : undefined}
      >
        <MessageCircle size={13} />
        {!compact && 'New Roundtable'}
      </button>
    </div>
  )
}

/**
 * Persistent three-pane workspace layout: a project rail, arbitrary center
 * content (TopBar + routed view), and a session rail. Layout breakpoints and
 * the overlay/drawer treatment for narrower viewports live in index.css
 * under `.workspace-shell`.
 */
export function WorkspaceShell({ children }: { children: ReactNode }): JSX.Element {
  const panels = useStore((s) => s.settings.panels)
  const panelSizes = useStore((s) => s.settings.panelSizes)
  const saveSettings = useStore((s) => s.saveSettings)
  const [draftSizes, setDraftSizes] = useState<Partial<Record<'projects' | 'sessions', number>>>({})
  const projectsWidth = draftSizes.projects ?? panelWidth(panelSizes, 'projects')
  const sessionsWidth = draftSizes.sessions ?? panelWidth(panelSizes, 'sessions')
  const commitSize = (key: 'projects' | 'sessions', next: number): void => {
    setDraftSizes((current) => ({ ...current, [key]: next }))
    void saveSettings({ panelSizes: { ...panelSizes, [key]: next } })
  }
  const [visibility, setVisibility] = useState<WorkspaceShellVisibility>({
    projectsOpen: true,
    sessionsOpen: false,
    inspectorOpen: true
  })
  const allSessions = useStore((s) => s.sessions)
  // Memoized (not inline `.filter()` in the selector) so the count only
  // recomputes when the underlying session list reference actually changes.
  const sessionCount = useMemo(
    () => allSessions.reduce((n, s) => (s.kind === 'normal' ? n + 1 : n), 0),
    [allSessions]
  )

  const isCompact = useMediaQuery('(max-width: 1099px)')
  const isCompactInspector = useMediaQuery('(max-width: 1279px)')

  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const inspectorRestoreFocusRef = useRef<HTMLElement | null>(null)

  const closeSessions = (): void => {
    setVisibility((v) => (v.sessionsOpen ? { ...v, sessionsOpen: false } : v))
    const restore = restoreFocusRef.current
    restoreFocusRef.current = null
    if (restore?.isConnected) restore.focus()
  }

  const openSessions = (trigger?: HTMLElement | null): void => {
    restoreFocusRef.current = trigger ?? (document.activeElement as HTMLElement | null)
    setVisibility((v) => ({ ...v, sessionsOpen: true }))
  }

  const toggleSessions = (trigger?: HTMLElement | null): void => {
    if (visibility.sessionsOpen) closeSessions()
    else openSessions(trigger)
  }

  const closeInspector = (): void => {
    setVisibility((v) => (v.inspectorOpen ? { ...v, inspectorOpen: false } : v))
    const restore = inspectorRestoreFocusRef.current
    inspectorRestoreFocusRef.current = null
    if (restore?.isConnected) restore.focus()
  }

  const toggleInspector = (trigger?: HTMLElement | null): void => {
    if (visibility.inspectorOpen) {
      closeInspector()
    } else {
      inspectorRestoreFocusRef.current = trigger ?? (document.activeElement as HTMLElement | null)
      setVisibility((v) => ({ ...v, inspectorOpen: true }))
    }
  }

  useEffect(() => {
    if ((!isCompact || !visibility.sessionsOpen) && (!isCompactInspector || !visibility.inspectorOpen)) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || document.querySelector('[role="dialog"]')) return
      if (isCompact && visibility.sessionsOpen) {
        event.preventDefault()
        closeSessions()
      } else if (isCompactInspector && visibility.inspectorOpen) {
        event.preventDefault()
        closeInspector()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCompact, isCompactInspector, visibility.inspectorOpen, visibility.sessionsOpen])

  const sessionsEffectivelyOpen = !isCompact || visibility.sessionsOpen

  const contextValue = useMemo<WorkspaceShellContextValue>(
    () => ({ ...visibility, toggleSessions, closeSessions, toggleInspector, closeInspector }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visibility]
  )

  return (
    <WorkspaceShellContext.Provider value={contextValue}>
      <div
        className="workspace-shell"
        style={{
          gridTemplateColumns: `${panelVisible(panels, 'projects') ? `${projectsWidth}px` : '0px'} minmax(0, 1fr) ${
            panelVisible(panels, 'sessions') ? `${sessionsWidth}px` : '0px'
          }`
        }}
      >
        {panelVisible(panels, 'projects') && (
          <aside className="glass-panel workspace-shell__projects flex flex-col" aria-label="Projects">
            <ProjectRail compact={isCompact} />
            <RavelStrip compact={isCompact} />
          </aside>
        )}
        {panelVisible(panels, 'projects') && (
          <ResizeHandle
            panel="projects"
            edge="right"
            absoluteAt={projectsWidth}
            width={projectsWidth}
            onPreview={(next) => setDraftSizes((current) => ({ ...current, projects: next }))}
            onCommit={(next) => commitSize('projects', next)}
          />
        )}

        <DocumentWorkspaceProvider>
          <div className="glass-panel workspace-shell__center">{children}</div>
        </DocumentWorkspaceProvider>

        <aside
          id="session-rail"
          className={`glass-panel workspace-shell__sessions ${
            sessionsEffectivelyOpen ? 'workspace-shell__sessions--open' : ''
          }`}
          aria-label="Sessions"
          aria-hidden={!sessionsEffectivelyOpen}
        >
          <SessionRail open={sessionsEffectivelyOpen} onRequestClose={closeSessions} />
        </aside>

        {panelVisible(panels, 'sessions') && !isCompact && (
          <ResizeHandle
            panel="sessions"
            edge="left"
            absoluteAt={sessionsWidth}
            width={sessionsWidth}
            onPreview={(next) => setDraftSizes((current) => ({ ...current, sessions: next }))}
            onCommit={(next) => commitSize('sessions', next)}
          />
        )}

        <button
          type="button"
          className="workspace-shell__sessions-toggle"
          onClick={(e) => toggleSessions(e.currentTarget)}
          aria-expanded={sessionsEffectivelyOpen}
          aria-controls="session-rail"
          aria-label={visibility.sessionsOpen ? `Hide sessions (${sessionCount})` : `Show sessions (${sessionCount})`}
          title={visibility.sessionsOpen ? 'Hide sessions' : 'Show sessions'}
        >
          <PanelRight size={15} />
          <span>Sessions ({sessionCount})</span>
        </button>
      </div>
    </WorkspaceShellContext.Provider>
  )
}
