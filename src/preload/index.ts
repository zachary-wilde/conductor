import { contextBridge, ipcRenderer } from 'electron'
import type { Insight } from '@shared/insights'
import type {
  CreateNormalSessionRequest,
  CreateRavelRequest,
  CreateRoundtableRequest,
  RoundtableActionResult,
  RoundtableConfig,
  CreateWorktreeRequest,
  DeleteBranchResult,
  HarnessAvailability,
  HarnessCatalogue,
  HarnessId,
  MergeBranchResult,
  MergeOptions,
  MergePreviewResult,
  PublicRavelConfig,
  RavelActionResult,
  RavelLogEntry,
  SessionActivityEntry,
  Repo,
  Session,
  SessionSnapshot,
  SessionStatus,
  Settings,
  UpdateRavelBriefAssignmentRequest,
  WorktreeInfo
} from '@shared/types'

const api = {
  // Repos
  listRepos: (): Promise<Repo[]> => ipcRenderer.invoke('repo:list'),
  addRepo: (path: string): Promise<Repo> => ipcRenderer.invoke('repo:add', path),
  removeRepo: (id: string): Promise<boolean> => ipcRenderer.invoke('repo:remove', id),

  // Remote access (operations core web server)
  getPairingInfo: (): Promise<{ url: string | null; token: string | null; code: string | null }> =>
    ipcRenderer.invoke('operations:pairing'),

  // Branches / worktrees
  listBranches: (repoPath: string): Promise<{ name: string; current: boolean }[]> =>
    ipcRenderer.invoke('branch:list', repoPath),
  currentBranch: (repoPath: string): Promise<string> =>
    ipcRenderer.invoke('branch:current', repoPath),
  listWorktrees: (repoPath: string): Promise<(WorktreeInfo & { conductor?: boolean })[]> =>
    ipcRenderer.invoke('worktree:list', repoPath),
  createWorktree: (
    req: CreateWorktreeRequest & { repoId: string }
  ): Promise<{ path: string; branch: string }> => ipcRenderer.invoke('worktree:create', req),
  removeWorktree: (p: { repoPath: string; targetPath: string; deleteBranch?: string }): Promise<boolean> =>
    ipcRenderer.invoke('worktree:remove', p),

  // Review and land
  mergePreview: (p: {
    repoPath: string
    branches: string[]
    baseBranch: string
  }): Promise<MergePreviewResult> => ipcRenderer.invoke('merge:preview', p),
  mergeLand: (p: {
    repoPath: string
    branch: string
    baseBranch: string
    options?: MergeOptions
  }): Promise<MergeBranchResult> => ipcRenderer.invoke('merge:land', p),
  deleteMergedBranch: (p: { repoPath: string; branch: string }): Promise<DeleteBranchResult> =>
    ipcRenderer.invoke('merge:deleteBranch', p),

  // Harnesses
  detectHarnesses: (): Promise<HarnessAvailability[]> => ipcRenderer.invoke('harness:detect'),
  resolveModelCatalogues: (): Promise<Record<HarnessId, HarnessCatalogue>> =>
    ipcRenderer.invoke('harness:modelCatalogues'),

  // Sessions
  createSession: (req: CreateNormalSessionRequest): Promise<Session> =>
    ipcRenderer.invoke('session:create', req),
  listSessions: (): Promise<Session[]> => ipcRenderer.invoke('session:list'),
  writeToSession: (id: string, data: string): Promise<boolean> =>
    ipcRenderer.invoke('session:write', id, data),
  resizeSession: (id: string, cols: number, rows: number): Promise<boolean> =>
    ipcRenderer.invoke('session:resize', id, cols, rows),
  killSession: (id: string): Promise<boolean> => ipcRenderer.invoke('session:kill', id),
  snapshotSession: (id: string): Promise<SessionSnapshot | null> =>
    ipcRenderer.invoke('session:snapshot', id),

  // Settings
  getSettings: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch: Partial<Settings>): Promise<Settings> =>
    ipcRenderer.invoke('settings:save', patch),
  getSettingsLoadError: (): Promise<string | null> => ipcRenderer.invoke('settings:loadError'),
  resetStore: (): Promise<void> => ipcRenderer.invoke('store:reset'),
  exportStore: (): Promise<string | null> => ipcRenderer.invoke('store:export'),
  importStore: (): Promise<boolean> => ipcRenderer.invoke('store:import'),
  // System
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('system:pickDirectory'),
  openPath: (p: string): Promise<string> => ipcRenderer.invoke('system:openPath', p),
  readFile: (p: string): Promise<string | null> => ipcRenderer.invoke('system:readFile', p),
  writeFile: (p: string, content: string): Promise<boolean> =>
    ipcRenderer.invoke('system:writeFile', p, content),
  acrylicMode: (): Promise<string> => ipcRenderer.invoke('window:acrylicMode'),
  minimizeWindow: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: (): Promise<boolean> => ipcRenderer.invoke('window:toggleMaximize'),
  closeWindow: (): Promise<void> => ipcRenderer.invoke('window:close'),
  listDir: (p: string): Promise<{ name: string; path: string; isDir: boolean }[]> =>
    ipcRenderer.invoke('fs:listDir', p),
  // Ravel
  createRavel: (req: CreateRavelRequest): Promise<RavelActionResult> =>
    ipcRenderer.invoke('ravel:create', req),
  listRavel: (): Promise<PublicRavelConfig[]> => ipcRenderer.invoke('ravel:list'),
  getRavel: (id: string): Promise<PublicRavelConfig | null> => ipcRenderer.invoke('ravel:get', id),
  getRavelLog: (id: string): Promise<RavelLogEntry[]> => ipcRenderer.invoke('ravel:log', id),
  getRavelChildren: (id: string): Promise<Session[]> => ipcRenderer.invoke('ravel:children', id),
  sendRavelMessage: (id: string, body: string): Promise<RavelActionResult | null> =>
    ipcRenderer.invoke('ravel:sendMessage', id, body),
  updateRavelBriefAssignment: (
    id: string,
    planRevision: number,
    briefId: string,
    assignment: UpdateRavelBriefAssignmentRequest
  ): Promise<RavelActionResult | null> =>
    ipcRenderer.invoke('ravel:updateBriefAssignment', id, planRevision, briefId, assignment),
  requestRavelPlanChanges: (
    id: string,
    planRevision: number,
    body: string
  ): Promise<RavelActionResult | null> =>
    ipcRenderer.invoke('ravel:requestPlanChanges', id, planRevision, body),
  approveRavelPlan: (id: string, planRevision: number): Promise<RavelActionResult | null> =>
    ipcRenderer.invoke('ravel:approvePlan', id, planRevision),
  retryRavelCompilation: (id: string): Promise<RavelActionResult | null> =>
    ipcRenderer.invoke('ravel:retryCompilation', id),
  resumeInterruptedRavelBrief: (
    id: string,
    planRevision: number,
    briefId: string
  ): Promise<RavelActionResult | null> =>
    ipcRenderer.invoke('ravel:resumeInterruptedBrief', id, planRevision, briefId),
  steerRavelChild: (id: string, sessionId: string, note: string): Promise<RavelActionResult | null> =>
    ipcRenderer.invoke('ravel:steerChild', id, sessionId, note),
  claimBrief: (id: string, planRevision: number, briefId: string): Promise<RavelActionResult | null> =>
    ipcRenderer.invoke('ravel:claimBrief', id, planRevision, briefId),
  askFromSeat: (sessionId: string, question: string): Promise<boolean> =>
    ipcRenderer.invoke('ravel:askFromSeat', sessionId, question),
  finishSeat: (sessionId: string, report: string, failed?: boolean): Promise<boolean> =>
    ipcRenderer.invoke('ravel:finishSeat', sessionId, report, failed === true),
  pauseRavel: (id: string): Promise<RavelActionResult | null> => ipcRenderer.invoke('ravel:pause', id),
  resumeRavel: (id: string): Promise<RavelActionResult | null> =>
    ipcRenderer.invoke('ravel:resume', id),
  deleteRavel: (id: string): Promise<RavelActionResult | null> => ipcRenderer.invoke('ravel:delete', id),

  listRoundtables: (): Promise<RoundtableConfig[]> => ipcRenderer.invoke('roundtable:list'),
  getRoundtable: (id: string): Promise<RoundtableConfig | null> => ipcRenderer.invoke('roundtable:get', id),
  createRoundtable: (req: CreateRoundtableRequest): Promise<RoundtableActionResult> =>
    ipcRenderer.invoke('roundtable:create', req),
  startRoundtable: (id: string): Promise<RoundtableActionResult> => ipcRenderer.invoke('roundtable:start', id),
  pauseRoundtable: (id: string): Promise<RoundtableActionResult> => ipcRenderer.invoke('roundtable:pause', id),
  addRoundtableNote: (id: string, body: string): Promise<RoundtableActionResult> =>
    ipcRenderer.invoke('roundtable:note', id, body),
  deleteRoundtable: (id: string): Promise<void> => ipcRenderer.invoke('roundtable:delete', id),
  onRoundtableUpdate: (cb: (cfg: RoundtableConfig) => void) => {
    const h = (_e: unknown, cfg: RoundtableConfig): void => cb(cfg)
    ipcRenderer.on('roundtable:update', h)
    return () => ipcRenderer.removeListener('roundtable:update', h)
  },
  onRoundtableRemoved: (cb: (id: string) => void) => {
    const h = (_e: unknown, id: string): void => cb(id)
    ipcRenderer.on('roundtable:removed', h)
    return () => ipcRenderer.removeListener('roundtable:removed', h)
  },

  getCurrentInsight: (): Promise<Insight | null> => ipcRenderer.invoke('insight:getCurrent'),
  dismissInsight: (): Promise<void> => ipcRenderer.invoke('insight:dismiss'),
  onInsight: (cb: (insight: Insight | null) => void) => {
    const h = (_e: unknown, insight: Insight | null): void => cb(insight)
    ipcRenderer.on('insight:update', h)
    return () => ipcRenderer.removeListener('insight:update', h)
  },


  // Events (streaming)
  onPtyData: (cb: (sessionId: string, data: string, generation: number) => void) => {
    const h = (_e: unknown, id: string, data: string, generation: number): void => cb(id, data, generation)
    ipcRenderer.on('pty:data', h)
    return () => ipcRenderer.removeListener('pty:data', h)
  },
  onPtyExit: (cb: (sessionId: string, code: number) => void) => {
    const h = (_e: unknown, id: string, code: number): void => cb(id, code)
    ipcRenderer.on('pty:exit', h)
    return () => ipcRenderer.removeListener('pty:exit', h)
  },
  onStatusChange: (cb: (sessionId: string, status: SessionStatus) => void) => {
    const h = (_e: unknown, id: string, status: SessionStatus): void => cb(id, status)
    ipcRenderer.on('session:status', h)
    return () => ipcRenderer.removeListener('session:status', h)
  },
  onHookResult: (cb: (info: unknown) => void) => {
    const h = (_e: unknown, info: unknown): void => cb(info)
    ipcRenderer.on('hook:result', h)
    return () => ipcRenderer.removeListener('hook:result', h)
  },
  onSessionActivity: (cb: (entries: SessionActivityEntry[]) => void) => {
    const h = (_e: unknown, entries: SessionActivityEntry[]): void => cb(entries)
    ipcRenderer.on('session:activity', h)
    return () => ipcRenderer.removeListener('session:activity', h)
  },
  onRavelUpdate: (cb: (cfg: PublicRavelConfig) => void) => {
    const h = (_e: unknown, cfg: PublicRavelConfig): void => cb(cfg)
    ipcRenderer.on('ravel:update', h)
    return () => ipcRenderer.removeListener('ravel:update', h)
  },
  onRavelLog: (cb: (entry: RavelLogEntry) => void) => {
    const h = (_e: unknown, entry: RavelLogEntry): void => cb(entry)
    ipcRenderer.on('ravel:log', h)
    return () => ipcRenderer.removeListener('ravel:log', h)
  },
  onRavelChildren: (cb: (ravelId: string) => void) => {
    const h = (_e: unknown, ravelId: string): void => cb(ravelId)
    ipcRenderer.on('ravel:children', h)
    return () => ipcRenderer.removeListener('ravel:children', h)
  },
  getCoreStatus: (): Promise<{ state: 'connecting' | 'connected' | 'error'; detail?: string }> =>
    ipcRenderer.invoke('core:status'),
  reconnectCore: (): Promise<void> => ipcRenderer.invoke('core:reconnect'),
  updaterStatus: () => ipcRenderer.invoke('updater:status'),
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  downloadUpdate: () => ipcRenderer.invoke('updater:download'),
  installUpdate: (confirmWithActiveSessions = false) =>
    ipcRenderer.invoke('updater:install', confirmWithActiveSessions),
  onUpdaterStatus: (cb: (status: unknown) => void) => {
    const h = (_e: unknown, status: unknown): void => cb(status)
    ipcRenderer.on('updater:status', h)
    return () => ipcRenderer.removeListener('updater:status', h)
  },
  onCoreStatus: (cb: (status: { state: 'connecting' | 'connected' | 'error'; detail?: string }) => void) => {
    const h = (_e: unknown, status: { state: 'connecting' | 'connected' | 'error'; detail?: string }): void => cb(status)
    ipcRenderer.on('core:status', h)
    return () => ipcRenderer.removeListener('core:status', h)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (e) {
    console.error('preload expose failed:', e)
  }
} else {
  // @ts-expect-error fallback when context isolation is disabled
  window.api = api
}
