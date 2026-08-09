import { create } from 'zustand'
import type {
  CreateRavelRequest,
  CreateRoundtableRequest,
  DeleteBranchResult,
  HarnessAvailability,
  HarnessCatalogue,
  HarnessId,
  MergeBranchResult,
  MergeOptions,
  MergePreviewResult,
  PublicRavelConfig,
  RavelActionError,
  RavelActionResult,
  RavelLogEntry,
  RoundtableActionResult,
  RoundtableConfig,
  SessionActivityEntry,
  Repo,
  Session,
  SessionStatus,
  Settings,
  UpdateRavelBriefAssignmentRequest
} from '@shared/types'
import type { CanvasPanelKind, CanvasState, CreateNormalSessionRequest } from '@shared/types'
import { DEFAULT_SETTINGS, STATIC_MODEL_CATALOGUES } from '@shared/types'
import * as canvas from '../lib/canvas'
import type { CoreStatus } from '../lib/coreStatus'
import { mergeRavelConfig, mergeRavelList, mergeRavelLogs, mergeSessions } from '../lib/ravelViewModel'

type View = 'dashboard' | 'session' | 'settings' | 'ravel' | 'roundtable'

export interface AppState {
  view: View
  selectedSessionId: string | null
  showNewSession: boolean
  newSessionPreset: 'terminal' | null
  /** Latest measured canvas size; never persisted. */
  canvasViewport: canvas.CanvasViewport | null
  /** Prevents a child mount from persisting defaults before settings finish loading. */
  canvasReady: boolean
  busy: boolean
  error: string | null
  /** Persisted store load failure, which enables the explicit recovery panel. */
  storeLoadError: string | null
  /** Core connection state, pushed by the main-process connection manager. */
  coreStatus: CoreStatus
  repos: Repo[]
  sessions: Session[]
  settings: Settings
  harnesses: HarnessAvailability[]
  /**
   * Models each harness offers. Seeded with the static fallback so every
   * dropdown has something to render on the first frame, then replaced once
   * the live probe answers.
   */
  modelCatalogues: Record<HarnessId, HarnessCatalogue>
  ravelList: PublicRavelConfig[]
  ravelLogs: Record<string, RavelLogEntry[]>
  activity: SessionActivityEntry[]
  selectedRavelId: string | null
  showNewRavel: boolean
  roundtables: RoundtableConfig[]
  selectedRoundtableId: string | null
  showNewRoundtable: boolean

  // lifecycle
  init: () => Promise<void>
  refreshRepos: () => Promise<void>
  refreshSessions: () => Promise<void>
  refreshHarnesses: () => Promise<void>
  refreshAll: () => void
  /** Force an immediate Core reconnect (the manager retries on its own). */
  reconnectCore: () => Promise<void>
  resetCorruptStore: () => Promise<void>
  exportStore: () => Promise<void>
  importStore: () => Promise<void>
  refreshModelCatalogues: () => Promise<void>
  /** Probe the installed CLIs for their live model lists, at most once per run. */
  ensureModelCatalogues: () => void

  addRepo: (path: string) => Promise<void>
  removeRepo: (id: string) => Promise<void>

  setView: (v: View) => void
  openSession: (id: string) => void
  openSettings: () => void
  back: () => void
  toggleNewSession: (open: boolean) => void
  openNewTerminal: () => void

  createSession: (req: CreateNormalSessionRequest) => Promise<Session | null>
  killSession: (id: string) => Promise<void>
  dismissSession: (id: string) => void

  saveSettings: (patch: Partial<Settings>) => Promise<void>

  /**
   * Floating-canvas arrangement. Every mutation persists through `saveSettings`;
   * geometry only arrives here when a drag or resize ENDS, never per frame.
   */
  openPanel: (kind: CanvasPanelKind, subjectId?: string | null) => void
  closePanel: (id: string) => void
  raisePanel: (id: string) => void
  setPanelGeometry: (id: string, rect: { x: number; y: number; w: number; h: number }) => void
  togglePanelMinimized: (id: string) => void
  saveLayout: (name: string) => void
  applyLayout: (id: string) => void
  deleteLayout: (id: string) => void
  /** Initialize once the canvas is measured and saved settings are available. */
  initializeCanvas: (width: number, height: number) => void
  resetCanvasToDefault: () => void
  /** Pull panels back into view after a resize or a layout from a bigger screen. */
  reflowCanvas: (width: number, height: number) => void

  /**
   * Review and land. All three resolve to the git primitive's own result shape
   * rather than throwing or raising the global error banner: a refused merge
   * belongs beside the branch that refused it, with its conflicting paths.
   */
  previewMerge: (repoPath: string, branches: string[], baseBranch: string) => Promise<MergePreviewResult>
  landBranch: (
    repoPath: string,
    branch: string,
    baseBranch: string,
    options?: MergeOptions
  ) => Promise<MergeBranchResult>
  deleteMergedBranch: (repoPath: string, branch: string) => Promise<DeleteBranchResult>

  // Ravel
  refreshRavel: () => Promise<void>
  createRavel: (req: CreateRavelRequest) => Promise<PublicRavelConfig | null>
  sendRavelMessage: (id: string, body: string) => Promise<PublicRavelConfig | null>
  updateRavelBriefAssignment: (
    id: string,
    planRevision: number,
    briefId: string,
    assignment: UpdateRavelBriefAssignmentRequest
  ) => Promise<PublicRavelConfig | null>
  requestRavelPlanChanges: (id: string, planRevision: number, body: string) => Promise<PublicRavelConfig | null>
  approveRavelPlan: (id: string, planRevision: number) => Promise<PublicRavelConfig | null>
  retryRavelCompilation: (id: string) => Promise<PublicRavelConfig | null>
  resumeInterruptedRavelBrief: (id: string, planRevision: number, briefId: string) => Promise<PublicRavelConfig | null>
  /** Take a brief yourself: a worktree, a shell in it, and a seat in the fleet. */
  claimBrief: (id: string, planRevision: number, briefId: string) => Promise<PublicRavelConfig | null>
  /** Redirect a running child; the manager decides what it actually hears. */
  steerRavelChild: (id: string, sessionId: string, note: string) => Promise<PublicRavelConfig | null>
  pauseRavel: (id: string) => Promise<void>
  resumeRavel: (id: string) => Promise<void>
  deleteRavel: (id: string) => Promise<void>
  toggleNewRavel: (open: boolean) => void
  openRavel: (id: string) => void
  /**
   * Pull a ravel's log and child sessions from the main process.
   *
   * `onRavelLog` only streams entries emitted while this window is listening,
   * so anything that happened before launch — or before a reload — was
   * invisible: the Log and Manager tabs rendered their empty states even
   * though the store held the full history.
   */
  hydrateRavel: (id: string) => Promise<void>

  // Roundtable
  refreshRoundtables: () => Promise<void>
  createRoundtable: (req: CreateRoundtableRequest) => Promise<RoundtableConfig | null>
  openRoundtable: (id: string) => void
  startRoundtable: (id: string) => Promise<void>
  pauseRoundtable: (id: string) => Promise<void>
  addRoundtableNote: (id: string, body: string) => Promise<RoundtableConfig | null>
  deleteRoundtable: (id: string) => Promise<void>
  toggleNewRoundtable: (open: boolean) => void

  clearError: () => void
}

let eventUnsubscribers: Array<() => void> = []
/** Model enumeration is expensive and rarely needed; it happens on demand, once. */
let cataloguesRequested = false
let inFlightOperations = 0
const tombstonedRavelIds = new Set<string>()
const ravelUpdateGenerations = new Map<string, number>()
const tombstonedRoundtableIds = new Set<string>()
const roundtableUpdateGenerations = new Map<string, number>()

function ravelActionErrorMessage(error: RavelActionError): string {
  return error.message ?? error.code
}


/**
 * Palette and translucency are independent root attributes; CSS does the rest.
 *
 * No-ops without a DOM. The store is exercised headlessly in unit tests, and
 * theming is a presentation side effect — it must never be the reason a
 * bootstrap path throws.
 */
function applyTheme(settings: Pick<Settings, 'theme' | 'acrylic' | 'acrylicIntensity'>): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.dataset.theme = settings.theme
  root.style.setProperty('--glass', String(settings.acrylicIntensity))
  if (settings.acrylic) root.dataset.acrylic = 'on'
  else delete root.dataset.acrylic
}

function unknownErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Apply a canvas transform, then persist it.
 *
 * A transform that changes nothing (raising the frontmost panel, applying a
 * layout that does not exist) returns the same object, and is skipped — a click
 * on the front panel must not write the store file.
 */
function applyCanvas(
  set: (partial: Partial<AppState>) => void,
  get: () => AppState,
  transform: (current: CanvasState) => CanvasState
): void {
  const settings = get().settings
  const next = transform(settings.canvas)
  if (next === settings.canvas) return
  set({ settings: { ...settings, canvas: next } })
  void window.api.saveSettings({ canvas: next })
}

/** Skipped until the canvas reports a size: geometry needs a real viewport. */
function applyMeasuredCanvas(
  set: (partial: Partial<AppState>) => void,
  get: () => AppState,
  transform: (current: CanvasState, viewport: canvas.CanvasViewport) => CanvasState
): void {
  const viewport = get().canvasViewport
  if (viewport === null) return
  applyCanvas(set, get, (current) => transform(current, viewport))
}

function bumpRavelGeneration(id: string): void {
  ravelUpdateGenerations.set(id, (ravelUpdateGenerations.get(id) ?? 0) + 1)
}

function captureRavelGenerations(): Map<string, number> {
  return new Map(ravelUpdateGenerations)
}

function bumpRoundtableGeneration(id: string): void {
  roundtableUpdateGenerations.set(id, (roundtableUpdateGenerations.get(id) ?? 0) + 1)
}

function mergeRoundtableList(list: RoundtableConfig[], incoming: RoundtableConfig): RoundtableConfig[] {
  const index = list.findIndex((item) => item.id === incoming.id)
  if (index === -1) return [...list, incoming]
  const next = list.slice()
  next[index] = incoming
  return next
}

function mergeListedRoundtables(
  current: RoundtableConfig[],
  incoming: RoundtableConfig[],
  generationSnapshot: ReadonlyMap<string, number>
): RoundtableConfig[] {
  const incomingById = new Map(
    incoming.filter((cfg) => !tombstonedRoundtableIds.has(cfg.id)).map((cfg) => [cfg.id, cfg])
  )
  const merged: RoundtableConfig[] = []
  const emitted = new Set<string>()
  for (const currentCfg of current) {
    if (tombstonedRoundtableIds.has(currentCfg.id)) continue
    const changed =
      (generationSnapshot.get(currentCfg.id) ?? 0) !== (roundtableUpdateGenerations.get(currentCfg.id) ?? 0)
    const incomingCfg = incomingById.get(currentCfg.id)
    if (changed) merged.push(currentCfg)
    else if (incomingCfg) merged.push(incomingCfg)
    if (changed || incomingCfg) emitted.add(currentCfg.id)
  }
  for (const incomingCfg of incomingById.values()) {
    const changed =
      (generationSnapshot.get(incomingCfg.id) ?? 0) !== (roundtableUpdateGenerations.get(incomingCfg.id) ?? 0)
    if (!emitted.has(incomingCfg.id) && !changed) merged.push(incomingCfg)
  }
  return merged
}

function ravelGenerationChanged(id: string, snapshot: ReadonlyMap<string, number>): boolean {
  return (snapshot.get(id) ?? 0) !== (ravelUpdateGenerations.get(id) ?? 0)
}

function mergeListedRavel(
  current: PublicRavelConfig[],
  incoming: PublicRavelConfig[],
  generationSnapshot: ReadonlyMap<string, number>
): PublicRavelConfig[] {
  const incomingById = new Map<string, PublicRavelConfig>()
  for (const cfg of incoming) {
    if (!tombstonedRavelIds.has(cfg.id)) incomingById.set(cfg.id, cfg)
  }

  const merged: PublicRavelConfig[] = []
  const emitted = new Set<string>()
  for (const currentCfg of current) {
    if (tombstonedRavelIds.has(currentCfg.id)) continue
    const incomingCfg = incomingById.get(currentCfg.id)
    if (ravelGenerationChanged(currentCfg.id, generationSnapshot)) {
      merged.push(currentCfg)
      emitted.add(currentCfg.id)
    } else if (incomingCfg !== undefined) {
      merged.push(mergeRavelConfig(currentCfg, incomingCfg))
      emitted.add(currentCfg.id)
    }
  }

  for (const incomingCfg of incomingById.values()) {
    if (!emitted.has(incomingCfg.id) && !ravelGenerationChanged(incomingCfg.id, generationSnapshot)) {
      merged.push(mergeRavelConfig(undefined, incomingCfg))
    }
  }
  return merged
}

function cleanupEventSubscriptions(): void {
  for (const unsubscribe of eventUnsubscribers) unsubscribe()
  eventUnsubscribers = []
}

export const useStore = create<AppState>((set, get) => {
  function beginOperation(): void {
    inFlightOperations += 1
    set({ busy: true, error: null })
  }

  function endOperation(): void {
    inFlightOperations = Math.max(0, inFlightOperations - 1)
    set({ busy: inFlightOperations > 0 })
  }

  async function applyRavelAction(action: () => Promise<RavelActionResult | null>): Promise<PublicRavelConfig | null> {
    beginOperation()
    try {
      const result = await action()
      if (result === null) {
        set({ error: 'Ravel not found.' })
        return null
      }
      if (!result.ok) {
        set({ error: ravelActionErrorMessage(result.error) })
        return null
      }
      tombstonedRavelIds.delete(result.ravel.id)
      bumpRavelGeneration(result.ravel.id)
      set((state) => ({ ravelList: mergeRavelList(state.ravelList, result.ravel), error: null }))
      return result.ravel
    } catch (error) {
      set({ error: unknownErrorMessage(error) })
      return null
    } finally {
      endOperation()
    }
  }

  function acceptRoundtableResult(result: RoundtableActionResult): RoundtableConfig | null {
    if (!result.ok) {
      set({ error: ravelActionErrorMessage(result.error) })
      return null
    }
    if (tombstonedRoundtableIds.has(result.roundtable.id)) return null
    bumpRoundtableGeneration(result.roundtable.id)
    set((state) => ({
      roundtables: mergeRoundtableList(state.roundtables, result.roundtable),
      error: null
    }))
    return result.roundtable
  }

  async function applyRoundtableAction(
    action: () => Promise<RoundtableActionResult>
  ): Promise<RoundtableConfig | null> {
    beginOperation()
    try {
      return acceptRoundtableResult(await action())
    } catch (error) {
      set({ error: unknownErrorMessage(error) })
      return null
    } finally {
      endOperation()
    }
  }

  function subscribeToEvents(): void {
    cleanupEventSubscriptions()
    eventUnsubscribers = [
      window.api.onStatusChange((id, status) => {
        set((state) => ({
          sessions: state.sessions.map((session) => (session.id === id ? { ...session, status } : session))
        }))
      }),
      window.api.onPtyExit((id) => {
        set((state) => ({
          sessions: state.sessions.map((session) =>
            session.id === id && session.status !== 'error' ? { ...session, status: 'closed' as SessionStatus } : session
          )
        }))
      }),
      window.api.onRavelUpdate((cfg) => {
        if (tombstonedRavelIds.has(cfg.id)) return
        bumpRavelGeneration(cfg.id)
        set((state) => ({ ravelList: mergeRavelList(state.ravelList, cfg) }))
      }),
      window.api.onRoundtableUpdate((cfg) => {
        if (tombstonedRoundtableIds.has(cfg.id)) return
        bumpRoundtableGeneration(cfg.id)
        set((state) => ({ roundtables: mergeRoundtableList(state.roundtables, cfg) }))
      }),
      window.api.onRoundtableRemoved((id) => {
        tombstonedRoundtableIds.add(id)
        bumpRoundtableGeneration(id)
        set((state) => {
          const removingSelected = state.selectedRoundtableId === id
          return {
            roundtables: state.roundtables.filter((item) => item.id !== id),
            selectedRoundtableId: removingSelected ? null : state.selectedRoundtableId,
            view: removingSelected ? 'dashboard' : state.view
          }
        })
      }),
      window.api.onRavelLog((entry) => {
        if (tombstonedRavelIds.has(entry.ravelId)) return
        set((state) => ({
          ravelLogs: {
            ...state.ravelLogs,
            [entry.ravelId]: mergeRavelLogs(state.ravelLogs[entry.ravelId] ?? [], [entry])
          }
        }))
      }),
      window.api.onSessionActivity((entries) => {
        set((state) => ({ activity: [...state.activity, ...entries].slice(-300) }))
      }),
      window.api.onRavelChildren(() => {
        void get().refreshSessions()
      }),
      window.api.onCoreStatus((status) => {
        // A transition INTO connected means panels may be stale from the outage;
        // re-pull the live lists so the workspace repopulates on its own.
        const wasConnected = get().coreStatus.state === 'connected'
        set({ coreStatus: status })
        if (status.state === 'connected' && !wasConnected) {
          void get().refreshAll()
        }
      })
    ]
  }

  return {
    view: 'dashboard',
    selectedSessionId: null,
    showNewSession: false,
    newSessionPreset: null,
    canvasViewport: null,
    canvasReady: false,
    busy: false,
    error: null,
    storeLoadError: null,
    coreStatus: { state: 'connecting' },
    repos: [],
    sessions: [],
    settings: { ...DEFAULT_SETTINGS },
    harnesses: [],
    modelCatalogues: STATIC_MODEL_CATALOGUES,
    ravelList: [],
    ravelLogs: {},
    activity: [],
    selectedRavelId: null,
    showNewRavel: false,
    roundtables: [],
    selectedRoundtableId: null,
    showNewRoundtable: false,

    init: async () => {
      subscribeToEvents()
      // Seed from the manager's current view before loading panels; the default
      // `connecting` stays if the read itself fails (the manager pushes the
      // truth, and a transient read failure must not block the rest of init).
      try {
        set({ coreStatus: await window.api.getCoreStatus() })
      } catch {
        /* leave the default connecting state */
      }
      const generationSnapshot = captureRavelGenerations()
      const roundtableGenerationSnapshot = new Map(roundtableUpdateGenerations)
      // Settled, not `Promise.all`. These loads are independent, and rejecting
      // the batch meant a single failing call (a harness probe, say) discarded
      // the settings and lists that had already resolved — the app then showed
      // defaults, which reads as "everything reset" rather than as an error.
      const [repos, settings, sessions, harnesses, ravelList, roundtables, loadError] = await Promise.allSettled([
        window.api.listRepos(),
        window.api.getSettings(),
        window.api.listSessions(),
        window.api.detectHarnesses(),
        window.api.listRavel(),
        window.api.listRoundtables(),
        window.api.getSettingsLoadError()
      ])

      const failures: string[] = []
      function taken<T>(result: PromiseSettledResult<T>, label: string, fallback: T): T {
        if (result.status === 'fulfilled') return result.value
        failures.push(`${label}: ${unknownErrorMessage(result.reason)}`)
        return fallback
      }

      const loaded = taken(settings, 'settings', { ...DEFAULT_SETTINGS })
      const viewport = get().canvasViewport
      const initializedCanvas =
        viewport === null
          ? loaded.canvas
          : canvas.clampToViewport(
              canvas.initializeDefaultCanvas(loaded.canvas, viewport.width, viewport.height),
              viewport.width,
              viewport.height
            )
      const loadedSettings =
        initializedCanvas === loaded.canvas ? loaded : { ...loaded, canvas: initializedCanvas }
      if (initializedCanvas !== loaded.canvas) {
        void window.api.saveSettings({ canvas: initializedCanvas })
      }
      applyTheme(loadedSettings)
      const storeError = taken(loadError, 'store status', null)

      set((state) => ({
        repos: taken(repos, 'repositories', state.repos),
        settings: loadedSettings,
        canvasReady: true,
        sessions: taken(sessions, 'sessions', state.sessions),
        harnesses: taken(harnesses, 'harnesses', state.harnesses),
        ravelList: mergeListedRavel(state.ravelList, taken(ravelList, 'ravels', []), generationSnapshot),
        roundtables: mergeListedRoundtables(
          state.roundtables,
          taken(roundtables, 'roundtables', []),
          roundtableGenerationSnapshot
        ),
        // A store that failed to load outranks a transient call failure: it is
        // why the rest looks empty, and it means writes are being refused.
        storeLoadError: storeError,
        error:
          storeError !== null
            ? `Saved settings and state could not be loaded, so Conductor is running on defaults and will not overwrite your file. ${storeError}`
            : failures.length > 0
              ? `Some state could not be loaded — ${failures.join('; ')}`
              : null
      }))

      // Model catalogues are NOT probed here. Enumeration spawns a CLI per
      // harness and costs seconds of real CPU; doing it at startup makes the
      // machine feel busy for the first few seconds of every launch, to
      // populate dropdowns the operator may never open. The static catalogues
      // are already in state, so `ensureModelCatalogues` is called by the
      // surfaces that actually show a model list.
    },

    refreshRepos: async () => {
      try {
        set({ repos: await window.api.listRepos(), error: null })
      } catch (error) {
        set({ error: unknownErrorMessage(error) })
      }
    },
    refreshSessions: async () => {
      try {
        set({ sessions: await window.api.listSessions(), error: null })
      } catch (error) {
        set({ error: unknownErrorMessage(error) })
      }
    },
    refreshHarnesses: async () => {
      try {
        set({ harnesses: await window.api.detectHarnesses(), error: null })
      } catch (error) {
        set({ error: unknownErrorMessage(error) })
      }
    },
    refreshAll: () => {
      // Fired on a Core reconnect: every live list may be stale from the outage,
      // so re-pull them. Settings and model catalogues are unaffected by a Core
      // drop and are deliberately left alone.
      void get().refreshRepos()
      void get().refreshSessions()
      void get().refreshHarnesses()
      void get().refreshRavel()
      void get().refreshRoundtables()
    },
    reconnectCore: async () => {
      // Flip optimistically so the banner reflects the retry before the next
      // pushed status arrives; the manager keeps retrying on its own regardless.
      set({ coreStatus: { state: 'connecting' } })
      await window.api.reconnectCore()
    },
    resetCorruptStore: async () => {
      try {
        await window.api.resetStore()
        await get().init()
      } catch (error) {
        set({ error: unknownErrorMessage(error) })
      }
    },
    exportStore: async () => {
      try {
        await window.api.exportStore()
      } catch (error) {
        set({ error: unknownErrorMessage(error) })
      }
    },
    importStore: async () => {
      try {
        await window.api.importStore()
        await get().init()
      } catch (error) {
        set({ error: unknownErrorMessage(error) })
      }
    },
    ensureModelCatalogues: () => {
      // Once per run. The probe result is memoised in the main process too, so
      // a second call would be cheap — but this keeps the CLI spawns to one
      // burst no matter how many dropdowns mount.
      if (cataloguesRequested) return
      cataloguesRequested = true
      void get().refreshModelCatalogues()
    },

    refreshModelCatalogues: async () => {
      try {
        set({ modelCatalogues: await window.api.resolveModelCatalogues() })
      } catch {
        // The main-process resolver never rejects, so this is a dead bridge
        // rather than a failed probe. State keeps the static catalogues, which
        // the UI already labels as the built-in list — no banner needed, and
        // one here would bury whatever actually broke the bridge.
      }
    },

    addRepo: async (path) => {
      try {
        await window.api.addRepo(path)
        await get().refreshRepos()
        set({ error: null })
      } catch (e) {
        set({ error: (e as Error).message })
      }
    },

    removeRepo: async (id) => {
      await window.api.removeRepo(id)
      await get().refreshRepos()
    },

    setView: (v) => set({ view: v }),
    openSession: (id) => {
      set({ view: 'session', selectedSessionId: id })
      get().openPanel('session', id)
    },
    openSettings: () => {
      set({ view: 'settings' })
      get().openPanel('settings')
    },
    back: () => set({
      view: 'dashboard',
      selectedSessionId: null,
      selectedRavelId: null,
      selectedRoundtableId: null
    }),
    toggleNewSession: (open) =>
      set({
        showNewSession: open,
        newSessionPreset: open ? get().newSessionPreset : null
      }),
    openNewTerminal: () =>
      set({ newSessionPreset: 'terminal', showNewSession: true, error: null }),

    createSession: async (req) => {
      beginOperation()
      try {
        const session = await window.api.createSession(req)
        set((state) => ({
          sessions: [session, ...state.sessions],
          showNewSession: false,
          newSessionPreset: null,
          error: null
        }))
        return session
      } catch (e) {
        set({ error: unknownErrorMessage(e) })
        return null
      } finally {
        endOperation()
      }
    },

    killSession: async (id) => {
      await window.api.killSession(id)
      set((s) => ({
        sessions: s.sessions.map((x) => (x.id === id ? { ...x, status: 'closed' } : x))
      }))
    },

    dismissSession: (id) =>
      set((s) => ({ sessions: s.sessions.filter((x) => x.id !== id) })),

    saveSettings: async (patch) => {
      const settings = await window.api.saveSettings(patch)
      applyTheme(settings)
      set({ settings })
      // harness availability may change if paths were edited.
      set({ harnesses: await window.api.detectHarnesses() })
    },

    // --- Canvas ---------------------------------------------------------
    //
    // Optimistic: the arrangement is applied to local state immediately so a
    // drag never waits on a disk write, then persisted. A failed write leaves
    // the panel where the operator put it for this run and loses only the
    // memory of it, which is the right way round for window furniture.
    openPanel: (kind, subjectId = null) =>
      applyCanvas(set, get, (current) =>
        canvas.openPanel(current, kind, subjectId, get().canvasViewport ?? canvas.DEFAULT_VIEWPORT)
      ),
    closePanel: (id) => applyCanvas(set, get, (current) => canvas.closePanel(current, id)),
    raisePanel: (id) => applyCanvas(set, get, (current) => canvas.raisePanel(current, id)),
    setPanelGeometry: (id, rect) =>
      applyMeasuredCanvas(set, get, (current, viewport) =>
        canvas.setGeometry(current, id, rect, viewport)
      ),
    togglePanelMinimized: (id) =>
      applyCanvas(set, get, (current) =>
        canvas.toggleMinimized(current, id, get().canvasViewport ?? canvas.DEFAULT_VIEWPORT)
      ),
    saveLayout: (name) => applyCanvas(set, get, (current) => canvas.saveLayout(current, name)),
    applyLayout: (id) =>
      applyMeasuredCanvas(set, get, (current, viewport) =>
        canvas.applyLayout(current, id, viewport)
      ),
    deleteLayout: (id) => applyCanvas(set, get, (current) => canvas.deleteLayout(current, id)),
    initializeCanvas: (width, height) => {
      const viewport = { width: Math.round(width), height: Math.round(height) }
      set({ canvasViewport: viewport })
      if (!get().canvasReady) return
      applyCanvas(set, get, (current) =>
        canvas.clampToViewport(
          canvas.initializeDefaultCanvas(current, viewport.width, viewport.height),
          viewport.width,
          viewport.height
        )
      )
    },
    resetCanvasToDefault: () =>
      applyMeasuredCanvas(set, get, (current, viewport) =>
        canvas.resetToCommandCentre(current, viewport.width, viewport.height)
      ),
    reflowCanvas: (width, height) => {
      const viewport = { width: Math.round(width), height: Math.round(height) }
      set({ canvasViewport: viewport })
      if (!get().canvasReady) return
      applyCanvas(set, get, (current) =>
        canvas.clampToViewport(current, viewport.width, viewport.height)
      )
    },

    previewMerge: async (repoPath, branches, baseBranch) => {
      beginOperation()
      try {
        return await window.api.mergePreview({ repoPath, branches, baseBranch })
      } catch (error) {
        return { ok: false, error: unknownErrorMessage(error) }
      } finally {
        endOperation()
      }
    },

    landBranch: async (repoPath, branch, baseBranch, options) => {
      beginOperation()
      try {
        return await window.api.mergeLand({ repoPath, branch, baseBranch, options })
      } catch (error) {
        // A bridge that never delivered the call: the repository was not touched.
        return { ok: false, error: unknownErrorMessage(error), restored: true }
      } finally {
        endOperation()
      }
    },

    deleteMergedBranch: async (repoPath, branch) => {
      beginOperation()
      try {
        return await window.api.deleteMergedBranch({ repoPath, branch })
      } catch (error) {
        return { ok: false, error: unknownErrorMessage(error) }
      } finally {
        endOperation()
      }
    },

    clearError: () => set({ error: null }),
    refreshRavel: async () => {
      beginOperation()
      const generationSnapshot = captureRavelGenerations()
      try {
        const ravelList = await window.api.listRavel()
        set((state) => ({ ravelList: mergeListedRavel(state.ravelList, ravelList, generationSnapshot), error: null }))
      } catch (error) {
        set({ error: unknownErrorMessage(error) })
      } finally {
        endOperation()
      }
    },

    createRavel: async (req) => {
      beginOperation()
      try {
        const result = await window.api.createRavel(req)
        if (!result.ok) {
          set({ error: ravelActionErrorMessage(result.error) })
          return null
        }
        tombstonedRavelIds.delete(result.ravel.id)
        bumpRavelGeneration(result.ravel.id)
        set((state) => ({
          ravelList: mergeRavelList(state.ravelList, result.ravel),
          selectedRavelId: result.ravel.id,
          showNewRavel: false,
          view: 'ravel',
          error: null
        }))
        return result.ravel
      } catch (error) {
        set({ error: unknownErrorMessage(error) })
        return null
      } finally {
        endOperation()
      }
    },

    sendRavelMessage: (id, body) => applyRavelAction(() => window.api.sendRavelMessage(id, body)),
    updateRavelBriefAssignment: (id, planRevision, briefId, assignment) =>
      applyRavelAction(() => window.api.updateRavelBriefAssignment(id, planRevision, briefId, assignment)),
    requestRavelPlanChanges: (id, planRevision, body) =>
      applyRavelAction(() => window.api.requestRavelPlanChanges(id, planRevision, body)),
    approveRavelPlan: (id, planRevision) => applyRavelAction(() => window.api.approveRavelPlan(id, planRevision)),
    retryRavelCompilation: (id) => applyRavelAction(() => window.api.retryRavelCompilation(id)),
    resumeInterruptedRavelBrief: (id, planRevision, briefId) =>
      applyRavelAction(() => window.api.resumeInterruptedRavelBrief(id, planRevision, briefId)),
    claimBrief: (id, planRevision, briefId) =>
      applyRavelAction(() => window.api.claimBrief(id, planRevision, briefId)),
    steerRavelChild: (id, sessionId, note) =>
      applyRavelAction(() => window.api.steerRavelChild(id, sessionId, note)),
    pauseRavel: async (id) => {
      await applyRavelAction(() => window.api.pauseRavel(id))
    },
    resumeRavel: async (id) => {
      await applyRavelAction(() => window.api.resumeRavel(id))
    },

    deleteRavel: async (id) => {
      beginOperation()
      try {
        const result = await window.api.deleteRavel(id)
        if (result === null) {
          set({ error: 'Ravel not found.' })
          return
        }
        if (!result.ok) {
          set({ error: ravelActionErrorMessage(result.error) })
          return
        }
        tombstonedRavelIds.add(id)
        bumpRavelGeneration(id)
        set((state) => {
          const { [id]: _removed, ...remainingLogs } = state.ravelLogs
          const removingSelected = state.selectedRavelId === id
          return {
            ravelList: state.ravelList.filter((item) => item.id !== id),
            ravelLogs: remainingLogs,
            selectedRavelId: removingSelected ? null : state.selectedRavelId,
            view: removingSelected ? 'dashboard' : state.view,
            error: null
          }
        })
      } catch (error) {
        set({ error: unknownErrorMessage(error) })
      } finally {
        endOperation()
      }
    },

    toggleNewRavel: (open) => set({ showNewRavel: open }),
    openRavel: (id) => {
      if (get().ravelList.some((item) => item.id === id)) {
        set({ view: 'ravel', selectedRavelId: id, error: null })
        get().openPanel('ravel', id)
        void get().hydrateRavel(id)
      } else {
        set({ error: 'Ravel not found.' })
      }
    },

    hydrateRavel: async (id) => {
      if (tombstonedRavelIds.has(id)) return
      try {
        const [entries, children] = await Promise.all([
          window.api.getRavelLog(id),
          window.api.getRavelChildren(id)
        ])
        if (tombstonedRavelIds.has(id)) return
        set((state) => ({
          ravelLogs: {
            ...state.ravelLogs,
            // Merge rather than replace: live entries may have landed via
            // onRavelLog while this fetch was in flight.
            [id]: mergeRavelLogs(state.ravelLogs[id] ?? [], entries)
          },
          sessions: mergeSessions(state.sessions, children)
        }))
      } catch (error) {
        set({ error: unknownErrorMessage(error) })
      }
    },

    refreshRoundtables: async () => {
      beginOperation()
      const generationSnapshot = new Map(roundtableUpdateGenerations)
      try {
        const roundtables = await window.api.listRoundtables()
        set((state) => ({
          roundtables: mergeListedRoundtables(state.roundtables, roundtables, generationSnapshot),
          error: null
        }))
      } catch (error) {
        set({ error: unknownErrorMessage(error) })
      } finally {
        endOperation()
      }
    },

    createRoundtable: async (req) => {
      const cfg = await applyRoundtableAction(() => window.api.createRoundtable(req))
      if (cfg) {
        tombstonedRoundtableIds.delete(cfg.id)
        set({
          selectedRoundtableId: cfg.id,
          showNewRoundtable: false,
          view: 'roundtable'
        })
      }
      return cfg
    },

    openRoundtable: (id) => {
      if (get().roundtables.some((item) => item.id === id)) {
        set({ view: 'roundtable', selectedRoundtableId: id, error: null })
        get().openPanel('roundtable', id)
      } else {
        set({ error: 'Roundtable not found.' })
      }
    },

    startRoundtable: (id) => {
      // The IPC promise spans the entire deliberation. Holding `busy` here
      // would disable the controls needed to interrupt and steer that run.
      set({ error: null })
      void window.api
        .startRoundtable(id)
        .then((result) => {
          acceptRoundtableResult(result)
        })
        .catch((error: unknown) => {
          set({ error: unknownErrorMessage(error) })
        })
      return Promise.resolve()
    },

    pauseRoundtable: async (id) => {
      await applyRoundtableAction(() => window.api.pauseRoundtable(id))
    },

    addRoundtableNote: (id, body) =>
      applyRoundtableAction(() => window.api.addRoundtableNote(id, body)),

    deleteRoundtable: async (id) => {
      beginOperation()
      try {
        await window.api.deleteRoundtable(id)
        tombstonedRoundtableIds.add(id)
        bumpRoundtableGeneration(id)
        set((state) => {
          const removingSelected = state.selectedRoundtableId === id
          return {
            roundtables: state.roundtables.filter((item) => item.id !== id),
            selectedRoundtableId: removingSelected ? null : state.selectedRoundtableId,
            view: removingSelected ? 'dashboard' : state.view,
            error: null
          }
        })
      } catch (error) {
        set({ error: unknownErrorMessage(error) })
      } finally {
        endOperation()
      }
    },

    toggleNewRoundtable: (open) => set({ showNewRoundtable: open })
  }
})

export function availableHarnesses(state: AppState): HarnessAvailability[] {
  return state.harnesses.filter((h) => h.available)
}

export function defaultHarnessId(state: AppState): HarnessId {
  const avail = availableHarnesses(state)
  const pref = state.settings.defaultHarness
  if (avail.some((h) => h.id === pref)) return pref
  return avail[0]?.id ?? 'claude'
}
