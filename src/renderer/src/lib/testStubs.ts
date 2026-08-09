// Imported only by tests. This is the single source of the renderer test harness:
// every renderer suite installs its `window.api` stub, resets the store, and builds
// Ravel fixtures from here rather than keeping its own drifting copy.
import { vi } from 'vitest'
import type { PublicRavelConfig, RoundtableConfig } from '@shared/types'
import { DEFAULT_SETTINGS, STATIC_MODEL_CATALOGUES } from '@shared/types'
import { type AppState, useStore } from '../store/useStore'

const NOW = 1_720_000_000_000

export function ravelFixture(overrides: Partial<PublicRavelConfig> = {}): PublicRavelConfig {
  return {
    id: 'ravel-1',
    name: 'Ravel',
    model: null,
    repoId: 'repo-1',
    repoPath: 'D:/repo',
    harness: 'claude',
    maxChildren: 4,
    allowRisky: false,
    status: 'idle',
    activity: 'idle',
    managerSessionId: null,
    messages: [],
    plan: null,
    dispatches: [],
    createdAt: NOW,
    error: null,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: null },
    ...overrides
  }
}

export function roundtableFixture(overrides: Partial<RoundtableConfig> = {}): RoundtableConfig {
  return {
    id: 'roundtable-1',
    name: 'Roundtable',
    repoId: 'repo-1',
    repoPath: 'D:/repo',
    topic: 'What should we do?',
    seats: [
      { id: 'seat-1', name: 'Builder', harness: 'claude', model: null, stance: '' },
      { id: 'seat-2', name: 'Sceptic', harness: 'codex', model: null, stance: '' }
    ],
    turns: [],
    maxTurns: 6,
    status: 'idle',
    conclusion: null,
    error: null,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: null },
    createdAt: NOW,
    ...overrides
  }
}

export function installApi(overrides: Partial<Window['api']> = {}): void {
  const api: Window['api'] = {
    getPairingInfo: vi.fn(async () => ({ url: null, token: null, code: null })),
    onSessionActivity: vi.fn(() => () => {}),
    acrylicMode: vi.fn(async () => 'unsupported'),
    minimizeWindow: vi.fn(async () => undefined),
    toggleMaximizeWindow: vi.fn(async () => false),
    closeWindow: vi.fn(async () => undefined),
    listRepos: vi.fn().mockResolvedValue([]),
    addRepo: vi.fn().mockResolvedValue(undefined),
    removeRepo: vi.fn().mockResolvedValue(undefined),
    listBranches: vi.fn().mockResolvedValue([]),
    currentBranch: vi.fn().mockResolvedValue('main'),
    listWorktrees: vi.fn().mockResolvedValue([]),
    listSessions: vi.fn().mockResolvedValue([]),
    createSession: vi.fn().mockResolvedValue({
      id: 'session-1',
      repoId: 'repo-1',
      repoPath: 'D:/repo',
      harness: 'claude',
      title: 'Session',
      status: 'running',
      createdAt: NOW,
      updatedAt: NOW,
      kind: 'normal'
    }),
    killSession: vi.fn().mockResolvedValue(true),
    writeToSession: vi.fn().mockResolvedValue(true),
    resizeSession: vi.fn().mockResolvedValue(true),
    getSettings: vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS }),
    saveSettings: vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS }),
    getSettingsLoadError: vi.fn().mockResolvedValue(null),
    resetStore: vi.fn().mockResolvedValue(undefined),
    exportStore: vi.fn().mockResolvedValue(null),
    importStore: vi.fn().mockResolvedValue(false),
    detectHarnesses: vi.fn().mockResolvedValue([]),
    resolveModelCatalogues: vi.fn().mockResolvedValue(STATIC_MODEL_CATALOGUES),
    createWorktree: vi.fn().mockResolvedValue({ path: 'D:/wt', branch: 'branch' }),
    removeWorktree: vi.fn().mockResolvedValue(true),
    mergePreview: vi.fn().mockResolvedValue({ ok: true, baseBranch: 'main', entries: [] }),
    mergeLand: vi.fn().mockResolvedValue({ ok: true, branch: 'b', commit: null, alreadyMerged: false, files: [], warning: null }),
    deleteMergedBranch: vi.fn().mockResolvedValue({ ok: true, branch: 'b' }),
    pickDirectory: vi.fn().mockResolvedValue(null),
    openPath: vi.fn().mockResolvedValue(''),
    readFile: vi.fn().mockResolvedValue(null),
    writeFile: vi.fn().mockResolvedValue(true),
    listDir: vi.fn().mockResolvedValue([]),
    createRavel: vi.fn().mockResolvedValue({ ok: true, ravel: ravelFixture() }),
    listRavel: vi.fn().mockResolvedValue([]),
    getRavel: vi.fn().mockResolvedValue(null),
    getRavelLog: vi.fn().mockResolvedValue([]),
    getRavelChildren: vi.fn().mockResolvedValue([]),
    sendRavelMessage: vi.fn().mockResolvedValue({ ok: true, ravel: ravelFixture() }),
    updateRavelBriefAssignment: vi.fn().mockResolvedValue({ ok: true, ravel: ravelFixture() }),
    requestRavelPlanChanges: vi.fn().mockResolvedValue({ ok: true, ravel: ravelFixture() }),
    approveRavelPlan: vi.fn().mockResolvedValue({ ok: true, ravel: ravelFixture() }),
    retryRavelCompilation: vi.fn().mockResolvedValue({ ok: true, ravel: ravelFixture() }),
    resumeInterruptedRavelBrief: vi.fn().mockResolvedValue({ ok: true, ravel: ravelFixture() }),
    steerRavelChild: vi.fn().mockResolvedValue({ ok: true, ravel: ravelFixture() }),
    claimBrief: vi.fn().mockResolvedValue({ ok: true, ravel: ravelFixture() }),
    askFromSeat: vi.fn().mockResolvedValue(true),
    finishSeat: vi.fn().mockResolvedValue(true),
    pauseRavel: vi.fn().mockResolvedValue({ ok: true, ravel: ravelFixture({ status: 'paused' }) }),
    resumeRavel: vi.fn().mockResolvedValue({ ok: true, ravel: ravelFixture({ status: 'running' }) }),
    deleteRavel: vi.fn().mockResolvedValue({ ok: true, ravel: ravelFixture() }),
    listRoundtables: vi.fn().mockResolvedValue([]),
    getRoundtable: vi.fn().mockResolvedValue(null),
    createRoundtable: vi.fn().mockResolvedValue({ ok: true, roundtable: roundtableFixture() }),
    startRoundtable: vi.fn().mockResolvedValue({ ok: true, roundtable: roundtableFixture({ status: 'concluded' }) }),
    pauseRoundtable: vi.fn().mockResolvedValue({ ok: true, roundtable: roundtableFixture({ status: 'paused' }) }),
    addRoundtableNote: vi.fn().mockResolvedValue({ ok: true, roundtable: roundtableFixture() }),
    deleteRoundtable: vi.fn().mockResolvedValue(undefined),
    onPtyData: vi.fn().mockReturnValue(vi.fn()),
    onPtyExit: vi.fn().mockReturnValue(vi.fn()),
    onStatusChange: vi.fn().mockReturnValue(vi.fn()),
    onHookResult: vi.fn().mockReturnValue(vi.fn()),
    onRavelUpdate: vi.fn().mockReturnValue(vi.fn()),
    onRavelLog: vi.fn().mockReturnValue(vi.fn()),
    onRavelChildren: vi.fn().mockReturnValue(vi.fn()),
    onRoundtableUpdate: vi.fn().mockReturnValue(vi.fn()),
    onRoundtableRemoved: vi.fn().mockReturnValue(vi.fn()),
    getCurrentInsight: vi.fn().mockResolvedValue(null),
    dismissInsight: vi.fn().mockResolvedValue(undefined),
    onInsight: vi.fn().mockReturnValue(vi.fn()),
    getCoreStatus: vi.fn().mockResolvedValue({ state: 'connecting' }),
    onCoreStatus: vi.fn().mockReturnValue(vi.fn()),
    reconnectCore: vi.fn().mockResolvedValue(undefined)
  }
  Object.assign(api, overrides)
  if (typeof globalThis.window === 'undefined') {
    Object.defineProperty(globalThis, 'window', {
      value: { api },
      configurable: true,
      writable: true
    })
  } else {
    Object.defineProperty(globalThis.window, 'api', {
      value: api,
      configurable: true,
      writable: true
    })
  }
}

export function resetStore(overrides: Partial<AppState> = {}): void {
  useStore.setState({
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
    selectedRavelId: null,
    showNewRavel: false,
    roundtables: [],
    selectedRoundtableId: null,
    showNewRoundtable: false,
    ...overrides
  })
}
