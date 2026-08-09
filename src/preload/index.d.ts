import type { Insight } from '@shared/insights'
import type {
  CreateNormalSessionRequest,
  CreateRavelRequest,
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
  CreateRoundtableRequest,
  RoundtableActionResult,
  RoundtableConfig,
  RavelLogEntry,
  SessionActivityEntry,
  Repo,
  Session,
  SessionStatus,
  Settings,
  UpdateRavelBriefAssignmentRequest,
  WorktreeInfo
} from '../shared/types'

export interface HookResultEvent {
  worktreePath: string
  ok: boolean
  exitCode: number | null
  stdout: string
  stderr: string
  ranWith: string
}

export interface PairingInfo {
  url: string | null
  token: string | null
  code: string | null
}

export interface ConductorApi {
  getCurrentInsight: () => Promise<Insight | null>
  dismissInsight: () => Promise<void>
  onInsight: (cb: (insight: Insight | null) => void) => () => void
  getPairingInfo: () => Promise<PairingInfo>

  listRepos: () => Promise<Repo[]>
  addRepo: (path: string) => Promise<Repo>
  removeRepo: (id: string) => Promise<boolean>

  listBranches: (repoPath: string) => Promise<{ name: string; current: boolean }[]>
  currentBranch: (repoPath: string) => Promise<string>
  listWorktrees: (repoPath: string) => Promise<(WorktreeInfo & { conductor?: boolean })[]>
  createWorktree: (
    req: CreateWorktreeRequest & { repoId: string }
  ) => Promise<{ path: string; branch: string }>
  removeWorktree: (p: {
    repoPath: string
    targetPath: string
    deleteBranch?: string
  }) => Promise<boolean>

  mergePreview: (p: {
    repoPath: string
    branches: string[]
    baseBranch: string
  }) => Promise<MergePreviewResult>
  mergeLand: (p: {
    repoPath: string
    branch: string
    baseBranch: string
    options?: MergeOptions
  }) => Promise<MergeBranchResult>
  deleteMergedBranch: (p: { repoPath: string; branch: string }) => Promise<DeleteBranchResult>

  detectHarnesses: () => Promise<HarnessAvailability[]>
  /** Live models per harness, falling back to the static list. Never rejects. */
  resolveModelCatalogues: () => Promise<Record<HarnessId, HarnessCatalogue>>

  createSession: (req: CreateNormalSessionRequest) => Promise<Session>
  listSessions: () => Promise<Session[]>
  writeToSession: (id: string, data: string) => Promise<boolean>
  resizeSession: (id: string, cols: number, rows: number) => Promise<boolean>
  killSession: (id: string) => Promise<boolean>

  getSettings: () => Promise<Settings>
  saveSettings: (patch: Partial<Settings>) => Promise<Settings>
  /** Non-null when the persisted store could not be read; writes are refused. */
  getSettingsLoadError: () => Promise<string | null>
  resetStore: () => Promise<void>
  exportStore: () => Promise<string | null>
  importStore: () => Promise<boolean>
  pickDirectory: () => Promise<string | null>
  openPath: (p: string) => Promise<string>
  readFile: (p: string) => Promise<string | null>
  writeFile: (p: string, content: string) => Promise<boolean>
  acrylicMode: () => Promise<string>
  minimizeWindow: () => Promise<void>
  toggleMaximizeWindow: () => Promise<boolean>
  closeWindow: () => Promise<void>
  listDir: (p: string) => Promise<{ name: string; path: string; isDir: boolean }[]>

  onPtyData: (cb: (sessionId: string, data: string) => void) => () => void
  onPtyExit: (cb: (sessionId: string, code: number) => void) => () => void
  onStatusChange: (cb: (sessionId: string, status: SessionStatus) => void) => () => void
  onHookResult: (cb: (info: HookResultEvent) => void) => () => void
  /** Core connection status for the reconnect banner. */
  getCoreStatus: () => Promise<{ state: 'connecting' | 'connected' | 'error'; detail?: string }>
  reconnectCore: () => Promise<void>
  onCoreStatus: (
    cb: (status: { state: 'connecting' | 'connected' | 'error'; detail?: string }) => void
  ) => () => void
  // Ravel
  createRavel: (req: CreateRavelRequest) => Promise<RavelActionResult>
  listRavel: () => Promise<PublicRavelConfig[]>
  getRavel: (id: string) => Promise<PublicRavelConfig | null>
  getRavelLog: (id: string) => Promise<RavelLogEntry[]>
  getRavelChildren: (id: string) => Promise<Session[]>
  sendRavelMessage: (id: string, body: string) => Promise<RavelActionResult | null>
  updateRavelBriefAssignment: (
    id: string,
    planRevision: number,
    briefId: string,
    assignment: UpdateRavelBriefAssignmentRequest
  ) => Promise<RavelActionResult | null>
  requestRavelPlanChanges: (
    id: string,
    planRevision: number,
    body: string
  ) => Promise<RavelActionResult | null>
  approveRavelPlan: (id: string, planRevision: number) => Promise<RavelActionResult | null>
  retryRavelCompilation: (id: string) => Promise<RavelActionResult | null>
  resumeInterruptedRavelBrief: (
    id: string,
    planRevision: number,
    briefId: string
  ) => Promise<RavelActionResult | null>
  steerRavelChild: (id: string, sessionId: string, note: string) => Promise<RavelActionResult | null>
  claimBrief: (id: string, planRevision: number, briefId: string) => Promise<RavelActionResult | null>
  askFromSeat: (sessionId: string, question: string) => Promise<boolean>
  finishSeat: (sessionId: string, report: string, failed?: boolean) => Promise<boolean>
  pauseRavel: (id: string) => Promise<RavelActionResult | null>
  resumeRavel: (id: string) => Promise<RavelActionResult | null>

  listRoundtables: () => Promise<RoundtableConfig[]>
  getRoundtable: (id: string) => Promise<RoundtableConfig | null>
  createRoundtable: (req: CreateRoundtableRequest) => Promise<RoundtableActionResult>
  startRoundtable: (id: string) => Promise<RoundtableActionResult>
  pauseRoundtable: (id: string) => Promise<RoundtableActionResult>
  addRoundtableNote: (id: string, body: string) => Promise<RoundtableActionResult>
  deleteRoundtable: (id: string) => Promise<void>
  onRoundtableUpdate: (cb: (cfg: RoundtableConfig) => void) => () => void
  onRoundtableRemoved: (cb: (id: string) => void) => () => void
  deleteRavel: (id: string) => Promise<RavelActionResult | null>

  onSessionActivity: (cb: (entries: SessionActivityEntry[]) => void) => () => void
  onRavelUpdate: (cb: (cfg: PublicRavelConfig) => void) => () => void
  onRavelLog: (cb: (entry: RavelLogEntry) => void) => () => void
  onRavelChildren: (cb: (ravelId: string) => void) => () => void
}

declare global {
  interface Window {
    api: ConductorApi
  }
}
