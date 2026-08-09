import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join, normalize } from 'node:path'
import {
  PANEL_IDS,
  MAX_CLARIFICATION_OPTIONS,
  PANEL_DOCKS,
  RAIL_PANEL_IDS,
  type PanelDock,
  type PanelId,
  type RailPanelId,
  ACRYLIC_INTENSITY_MAX,
  ACRYLIC_INTENSITY_MIN,
  CONDUCTOR_THEMES,
  DEFAULT_SETTINGS,
  type DispatchVerification,
  EMPTY_RAVEL_USAGE,
  type RoundtableConfig,
  type RoundtableSeat,
  type RoundtableTurn,
  type RavelBrief,
  type RavelConfig,
  type RavelDispatchRecord,
  type RavelMessage,
  type RavelMission,
  type RavelPlan,
  type RavelUsage,
  type Repo,
  type Settings,
  type CanvasPanel,
  type CanvasState,
  CANVAS_DEFAULT_SIZE,
  CANVAS_PANEL_MIN,
  EMPTY_CANVAS
} from '@shared/types'
import {
  EMPTY_INSIGHT_STATE,
  INSIGHT_SEEN_LIMIT,
  type Insight,
  type InsightState
} from '@shared/insights'
import { clipOrientation, interruptLiveDispatchesForRestart } from './ravel-model'

type WorktreeRecord = Record<
  string,
  { repoId: string; repoPath: string; branch: string; createdAt: number }
>

export interface StoreShapeV2 {
  schemaVersion: 2
  repos: Repo[]
  settings: Settings
  /** Worktrees Conductor created, keyed by path, for cleanup tracking. */
  worktrees: WorktreeRecord
  ravel: RavelConfig[]
  /** Absent in every store written before roundtables existed; defaults to []. */
  roundtables?: RoundtableConfig[]
  /**
   * Absent in every store written before the mascot existed; defaults to empty.
   * Persisted so an observation is never repeated across a restart.
   */
  insights?: InsightState
}

export interface ConductorStore {
  init: () => StoreShapeV2
  getLoadError: () => Error | null
  reset: () => void
  exportTo: (destinationFile: string) => void
  importFrom: (sourceFile: string) => void
  getRepos: () => Repo[]
  addRepo: (repo: Repo) => Repo
  removeRepo: (id: string) => void
  getSettings: () => Settings
  saveSettings: (patch: Partial<Settings>) => Settings
  getWorktrees: () => WorktreeRecord
  trackWorktree: (path: string, meta: { repoId: string; repoPath: string; branch: string }) => void
  untrackWorktree: (path: string) => void
  getRavel: () => RavelConfig[]
  getRavelById: (id: string) => RavelConfig | undefined
  addRavel: (cfg: RavelConfig) => RavelConfig
  replaceRavel: (id: string, cfg: RavelConfig) => RavelConfig | undefined
  updateRavel: (id: string, patch: Partial<RavelConfig>) => RavelConfig | undefined
  removeRavel: (id: string) => void
  listRoundtables: () => RoundtableConfig[]
  getRoundtable: (id: string) => RoundtableConfig | undefined
  addRoundtable: (cfg: RoundtableConfig) => RoundtableConfig
  replaceRoundtable: (id: string, cfg: RoundtableConfig) => RoundtableConfig | undefined
  removeRoundtable: (id: string) => void
  getInsightState: () => InsightState
  saveInsightState: (state: InsightState) => InsightState
}

interface ElectronAppPathResolver {
  getPath: (name: 'userData') => string
}

interface LegacyArgusConfig {
  id: string
  name: string
  repoId: string
  repoPath: string
  harness: RavelConfig['harness']
  mission: string
  maxChildren: number
  allowRisky: boolean
  status: string
  managerSessionId: string | null
  createdAt: number
}

function cloneDefaultSettings(): Settings {
  return {
    ...DEFAULT_SETTINGS,
    panelOrder: [...DEFAULT_SETTINGS.panelOrder],
    panelDock: { ...DEFAULT_SETTINGS.panelDock },
    harnessPaths: { ...DEFAULT_SETTINGS.harnessPaths },
    harnessArgs: { ...DEFAULT_SETTINGS.harnessArgs },
    harnessFallback: [...DEFAULT_SETTINGS.harnessFallback],
    hooks: {
      global: DEFAULT_SETTINGS.hooks.global,
      perRepo: { ...DEFAULT_SETTINGS.hooks.perRepo }
    },
    editor: { ...DEFAULT_SETTINGS.editor },
    canvas: cloneJson(EMPTY_CANVAS)
  }
}

function cloneJson<T>(value: T): T {
  return structuredClone(value)
}

function emptyStore(): StoreShapeV2 {
  return {
    schemaVersion: 2,
    repos: [],
    settings: cloneDefaultSettings(),
    worktrees: {},
    ravel: []
  }
}

function defaultStoreFile(): string {
  // The headless Core sets CONDUCTOR_DATA_DIR to its versioned dir so the store
  // resolves without Electron (a plain Node process has no `app`). Electron
  // leaves it unset and keeps the userData path.
  const headlessDir = process.env.CONDUCTOR_DATA_DIR
  if (headlessDir) return join(headlessDir, 'store.json')
  const electron = require('electron') as { app: ElectronAppPathResolver }
  return join(electron.app.getPath('userData'), 'conductor-data', 'store.json')
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function failLoad(error: unknown): Error {
  return new Error(`failed to load store: ${messageFromError(error)}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

function isHarness(value: unknown): value is RavelConfig['harness'] {
  return value === 'claude' || value === 'codex' || value === 'zai'
}

function isTheme(value: unknown): value is Settings['theme'] {
  return CONDUCTOR_THEMES.includes(value as Settings['theme'])
}

function isRavelStatus(value: unknown): value is RavelConfig['status'] {
  return (
    value === 'idle' ||
    value === 'awaiting-approval' ||
    value === 'running' ||
    value === 'paused' ||
    value === 'completed' ||
    value === 'error'
  )
}

function isRavelActivity(value: unknown): value is RavelConfig['activity'] {
  return value === 'idle' || value === 'thinking' || value === 'needs-clarification'
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isNumberOrNull(value: unknown): value is number | null {
  return value === null || isNumber(value)
}

function isMessageAuthor(value: unknown): value is RavelMessage['author'] {
  return value === 'user' || value === 'ravel' || value === 'system'
}

function isMessageDelivery(value: unknown): value is RavelMessage['delivery'] {
  return value === 'pending' || value === 'delivered' || value === 'failed'
}

function isChildRole(value: unknown): value is RavelBrief['role'] {
  return value === 'lead-engineer' || value === 'auditor' || value === 'minor-task'
}

function isBriefPhase(value: unknown): value is RavelBrief['phase'] {
  return (
    value === 'before-implementation' ||
    value === 'implementation' ||
    value === 'after-implementation'
  )
}

function isDispatchStatus(value: unknown): value is RavelDispatchRecord['status'] {
  return (
    value === 'starting' ||
    value === 'active' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'interrupted'
  )
}

function validateStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`invalid ${label}`)
  return value.map((item, index) => {
    if (!isString(item)) throw new Error(`invalid ${label} at index ${index}`)
    return item
  })
}

function validateRepo(value: unknown, index: number): Repo {
  if (!isRecord(value)) throw new Error(`invalid repo record at index ${index}`)
  if (
    !isString(value.id) ||
    !isString(value.path) ||
    !isString(value.name) ||
    !isNumber(value.addedAt)
  ) {
    throw new Error(`invalid repo record at index ${index}`)
  }
  return { id: value.id, path: value.path, name: value.name, addedAt: value.addedAt }
}

function validateRepos(value: unknown): Repo[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('invalid repos')
  return value.map(validateRepo)
}

function validateWorktrees(value: unknown): WorktreeRecord {
  if (value === undefined) return {}
  if (!isRecord(value)) throw new Error('invalid worktrees')
  const worktrees: WorktreeRecord = {}
  for (const [path, meta] of Object.entries(value)) {
    if (
      !isRecord(meta) ||
      !isString(meta.repoId) ||
      !isString(meta.repoPath) ||
      !isString(meta.branch) ||
      !isNumber(meta.createdAt)
    ) {
      throw new Error(`invalid worktree record for ${path}`)
    }
    worktrees[path] = {
      repoId: meta.repoId,
      repoPath: meta.repoPath,
      branch: meta.branch,
      createdAt: meta.createdAt
    }
  }
  return worktrees
}

function validateStringMap(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return {}
  if (!isRecord(value)) throw new Error(`invalid ${label}`)
  const output: Record<string, string> = {}
  for (const [key, entryValue] of Object.entries(value)) {
    if (!isString(entryValue)) throw new Error(`invalid ${label} value for ${key}`)
    output[key] = entryValue
  }
  return output
}

function validateHarnessPaths(value: unknown): Settings['harnessPaths'] {
  const output: Settings['harnessPaths'] = {}
  for (const [key, entryValue] of Object.entries(validateStringMap(value, 'harnessPaths'))) {
    if (isHarness(key)) output[key] = entryValue
  }
  return output
}

function validateHarnessArgs(value: unknown): Settings['harnessArgs'] {
  if (value === undefined) return {}
  if (!isRecord(value)) throw new Error('invalid harnessArgs')
  const output: Settings['harnessArgs'] = {}
  for (const [key, entryValue] of Object.entries(value)) {
    if (!Array.isArray(entryValue)) throw new Error(`invalid harnessArgs value for ${key}`)
    const args = validateStringArray(entryValue, `harnessArgs ${key}`)
    if (isHarness(key)) output[key] = args
  }
  return output
}

/**
 * Per-harness default models. Stores written before model selection existed
 * carry a single `zaiModel` string; it is folded into the map so upgrades keep
 * the user's configured ZAI model.
 */
function validateHarnessModels(value: unknown, legacyZaiModel: unknown): Settings['harnessModels'] {
  const output: Settings['harnessModels'] = {}
  if (legacyZaiModel !== undefined) {
    if (!isString(legacyZaiModel)) throw new Error('invalid settings zaiModel')
    if (legacyZaiModel.length > 0) output.zai = legacyZaiModel
  }
  if (value === undefined) return output
  for (const [key, entryValue] of Object.entries(validateStringMap(value, 'harnessModels'))) {
    if (isHarness(key)) output[key] = entryValue
  }
  return output
}

function mergeSettings(value: unknown): Settings {
  const settings = cloneDefaultSettings()
  if (value === undefined) return settings
  if (!isRecord(value)) throw new Error('invalid settings')

  const defaultHarness = value.defaultHarness === undefined ? settings.defaultHarness : value.defaultHarness
  if (!isHarness(defaultHarness)) throw new Error('invalid settings defaultHarness')
  // 'acrylic' used to be a theme; it is now the orthogonal translucency flag.
  const legacyAcrylicTheme = value.theme === 'acrylic'
  const themeValue = value.theme === undefined || legacyAcrylicTheme ? settings.theme : value.theme
  if (!isTheme(themeValue)) throw new Error('invalid settings theme')
  const theme = themeValue
  const acrylicValue = value.acrylic === undefined ? (legacyAcrylicTheme ? true : settings.acrylic) : value.acrylic
  if (typeof acrylicValue !== 'boolean') throw new Error('invalid settings acrylic')
  const acrylic = acrylicValue
  const autostartValue = value.autostart === undefined ? settings.autostart : value.autostart
  if (!isBoolean(autostartValue)) throw new Error('invalid settings autostart')
  const autostart = autostartValue
  const intensityValue =
    value.acrylicIntensity === undefined ? settings.acrylicIntensity : value.acrylicIntensity
  if (
    typeof intensityValue !== 'number' ||
    !Number.isFinite(intensityValue) ||
    intensityValue < ACRYLIC_INTENSITY_MIN ||
    intensityValue > ACRYLIC_INTENSITY_MAX
  ) {
    throw new Error('invalid settings acrylicIntensity')
  }
  const acrylicIntensity = Math.round(intensityValue)
  const panelSizes: Settings['panelSizes'] = {}
  if (value.panelSizes !== undefined) {
    if (!isRecord(value.panelSizes)) throw new Error('invalid settings panelSizes')
    for (const [key, entry] of Object.entries(value.panelSizes)) {
      if (typeof entry !== 'number' || !Number.isFinite(entry)) {
        throw new Error(`invalid settings panelSizes value for ${key}`)
      }
      if (key === 'projects' || key === 'sessions' || key === 'ravelRail' || key === 'ravelRailLeft') {
        panelSizes[key] = Math.round(entry)
      }
    }
  }
  const panels: Settings['panels'] = {}
  if (value.panels !== undefined) {
    if (!isRecord(value.panels)) throw new Error('invalid settings panels')
    for (const [key, entry] of Object.entries(value.panels)) {
      if (typeof entry !== 'boolean') throw new Error(`invalid settings panels value for ${key}`)
      if ((PANEL_IDS as readonly string[]).includes(key)) panels[key as PanelId] = entry
    }
  }
  const panelOrder: Settings['panelOrder'] = []
  if (value.panelOrder !== undefined) {
    if (!Array.isArray(value.panelOrder)) throw new Error('invalid settings panelOrder')
    for (const entry of value.panelOrder) {
      if (typeof entry !== 'string') throw new Error('invalid settings panelOrder entry')
      // Unknown or repeated ids are dropped rather than rejected: an order
      // written by a newer build must never lock an older one out of writes.
      if ((PANEL_IDS as readonly string[]).includes(entry) && !panelOrder.includes(entry as PanelId)) {
        panelOrder.push(entry as PanelId)
      }
    }
  }
  const panelDock: Settings['panelDock'] = {}
  if (value.panelDock !== undefined) {
    if (!isRecord(value.panelDock)) throw new Error('invalid settings panelDock')
    for (const [key, entry] of Object.entries(value.panelDock)) {
      if (typeof entry !== 'string') throw new Error(`invalid settings panelDock value for ${key}`)
      // Same policy as panelOrder: an unknown panel or an unknown dock written
      // by a newer build is dropped, never rejected, so it cannot lock an
      // older build out of writing its settings.
      if ((RAIL_PANEL_IDS as readonly string[]).includes(key) && (PANEL_DOCKS as readonly string[]).includes(entry)) {
        panelDock[key as RailPanelId] = entry as PanelDock
      }
    }
  }
  const harnessModels =
    value.harnessModels === undefined && value.zaiModel === undefined
      ? settings.harnessModels
      : validateHarnessModels(value.harnessModels, value.zaiModel)
  const worktreeRoot = value.worktreeRoot === undefined ? settings.worktreeRoot : value.worktreeRoot
  if (!isStringOrNull(worktreeRoot)) throw new Error('invalid settings worktreeRoot')
  const ceilingValue =
    value.tokenCeilingPerRavel === undefined ? settings.tokenCeilingPerRavel : value.tokenCeilingPerRavel
  if (typeof ceilingValue !== 'number' || !Number.isFinite(ceilingValue) || ceilingValue < 0) {
    throw new Error('invalid settings tokenCeilingPerRavel')
  }
  const tokenCeilingPerRavel = Math.round(ceilingValue)

  const hooks = { ...settings.hooks }
  if (value.hooks !== undefined) {
    if (!isRecord(value.hooks)) throw new Error('invalid settings hooks')
    const global = value.hooks.global === undefined ? hooks.global : value.hooks.global
    if (!isStringOrNull(global)) throw new Error('invalid settings hooks.global')
    hooks.global = global
    hooks.perRepo =
      value.hooks.perRepo === undefined
        ? hooks.perRepo
        : validateStringMap(value.hooks.perRepo, 'hooks.perRepo')
  }

  const verify = { ...settings.verify }
  if (value.verify !== undefined) {
    if (!isRecord(value.verify)) throw new Error('invalid settings verify')
    const global = value.verify.global === undefined ? verify.global : value.verify.global
    if (!isStringOrNull(global)) throw new Error('invalid settings verify.global')
    verify.global = global
    verify.perRepo =
      value.verify.perRepo === undefined
        ? verify.perRepo
        : validateStringMap(value.verify.perRepo, 'verify.perRepo')
  }

  const editor = { ...settings.editor }
  if (value.editor !== undefined) {
    if (!isRecord(value.editor)) throw new Error('invalid settings editor')
    const fontFamily =
      value.editor.fontFamily === undefined ? editor.fontFamily : value.editor.fontFamily
    if (!isString(fontFamily)) throw new Error('invalid settings editor.fontFamily')
    const fontSize = value.editor.fontSize === undefined ? editor.fontSize : value.editor.fontSize
    if (!isNumber(fontSize)) throw new Error('invalid settings editor.fontSize')
    const wordWrap = value.editor.wordWrap === undefined ? editor.wordWrap : value.editor.wordWrap
    if (!isBoolean(wordWrap)) throw new Error('invalid settings editor.wordWrap')
    const minimap = value.editor.minimap === undefined ? editor.minimap : value.editor.minimap
    if (!isBoolean(minimap)) throw new Error('invalid settings editor.minimap')
    const gotoDefinition =
      value.editor.gotoDefinition === undefined
        ? editor.gotoDefinition
        : value.editor.gotoDefinition
    if (!isBoolean(gotoDefinition)) throw new Error('invalid settings editor.gotoDefinition')
    editor.fontFamily = fontFamily
    editor.fontSize = fontSize
    editor.wordWrap = wordWrap
    editor.minimap = minimap
    editor.gotoDefinition = gotoDefinition
  }

  const harnessFallback: Settings['harnessFallback'] = []
  if (value.harnessFallback !== undefined) {
    if (!Array.isArray(value.harnessFallback)) throw new Error('invalid settings harnessFallback')
    for (const entry of value.harnessFallback) {
      // Drop-unknown/dup policy (as panelOrder): a list written by a newer build
      // must never lock an older one out of writes.
      if (isHarness(entry) && !harnessFallback.includes(entry)) harnessFallback.push(entry)
    }
  }

  return {
    defaultHarness,
    theme,
    acrylic,
    acrylicIntensity,
    panels: value.panels === undefined ? settings.panels : panels,
    panelOrder: value.panelOrder === undefined ? settings.panelOrder : panelOrder,
    panelDock: value.panelDock === undefined ? settings.panelDock : panelDock,
    panelSizes: value.panelSizes === undefined ? settings.panelSizes : panelSizes,
    harnessPaths:
      value.harnessPaths === undefined
        ? settings.harnessPaths
        : validateHarnessPaths(value.harnessPaths),
    harnessModels,
    harnessArgs:
      value.harnessArgs === undefined ? settings.harnessArgs : validateHarnessArgs(value.harnessArgs),
    harnessFallback: value.harnessFallback === undefined ? settings.harnessFallback : harnessFallback,
    hooks,
    verify,
    autostart,
    shellHooksConsented:
      typeof value.shellHooksConsented === 'boolean'
        ? value.shellHooksConsented
        : settings.shellHooksConsented,
    worktreeRoot,
    tokenCeilingPerRavel,
    editor,
    canvas: validateCanvas(value.canvas)
  }
}

const CANVAS_KINDS: Record<string, true | undefined> = {
  sessions: true,
  work: true,
  fleet: true,
  session: true,
  ravel: true,
  roundtable: true,
  settings: true
}

function finite(value: unknown, fallback: number): number {
  return isNumber(value) ? Math.round(value) : fallback
}

function validateCanvasPanel(value: unknown): CanvasPanel | null {
  if (!isRecord(value) || !isString(value.id) || !CANVAS_KINDS[String(value.kind)]) return null
  const kind = value.kind as CanvasPanel['kind']
  const size = CANVAS_DEFAULT_SIZE[kind]
  return {
    id: value.id,
    kind,
    subjectId: isString(value.subjectId) ? value.subjectId : null,
    // Position is clamped to >= 0 but not to the viewport: the window may be
    // smaller now than when the layout was saved, and the canvas re-homes any
    // panel that would land off-screen when it mounts.
    x: Math.max(0, finite(value.x, 24)),
    y: Math.max(0, finite(value.y, 24)),
    w: Math.max(CANVAS_PANEL_MIN.w, finite(value.w, size.w)),
    h: Math.max(CANVAS_PANEL_MIN.h, finite(value.h, size.h)),
    z: finite(value.z, 1),
    minimized: value.minimized === true
  }
}

/**
 * A malformed panel is DROPPED, not thrown on.
 *
 * Unlike a ravel or an insight, a window position carries no work: refusing to
 * load the store over one bad rectangle would cost the operator everything else
 * in it to save a layout they can redraw in seconds.
 */
function validateCanvas(value: unknown): CanvasState {
  if (value === undefined) return cloneJson(EMPTY_CANVAS)
  if (!isRecord(value)) throw new Error('invalid canvas')

  const panels = Array.isArray(value.panels)
    ? value.panels.map(validateCanvasPanel).filter((panel): panel is CanvasPanel => panel !== null)
    : []

  const layouts = Array.isArray(value.layouts)
    ? value.layouts.flatMap((layout) => {
        if (!isRecord(layout) || !isString(layout.id) || !isString(layout.name)) return []
        const saved = Array.isArray(layout.panels)
          ? layout.panels.map(validateCanvasPanel).filter((p): p is CanvasPanel => p !== null)
          : []
        return [{ id: layout.id, name: layout.name, panels: saved }]
      })
    : []

  const activeLayoutId = isString(value.activeLayoutId) ? value.activeLayoutId : null
  const defaultLayoutVersion = Math.max(0, finite(value.defaultLayoutVersion, 0))
  return {
    panels,
    layouts,
    // A pointer at a layout that no longer exists is worse than none.
    activeLayoutId: layouts.some((l) => l.id === activeLayoutId) ? activeLayoutId : null,
    defaultLayoutVersion
  }
}

function validateMessage(value: unknown, index: number): RavelMessage {
  if (!isRecord(value)) throw new Error(`invalid ravel message at index ${index}`)
  if (
    !isString(value.id) ||
    !isMessageAuthor(value.author) ||
    !isString(value.body) ||
    !isNumber(value.createdAt) ||
    !isMessageDelivery(value.delivery)
  ) {
    throw new Error(`invalid ravel message at index ${index}`)
  }
  // Absent on every message written before clarifications could offer choices,
  // and dropped rather than rejected when malformed: a bad option list must
  // never cost the operator the conversation it belongs to.
  const options = Array.isArray(value.options)
    ? value.options.filter(isString).slice(0, MAX_CLARIFICATION_OPTIONS)
    : []
  return {
    id: value.id,
    author: value.author,
    body: value.body,
    createdAt: value.createdAt,
    delivery: value.delivery,
    ...(options.length > 0 ? { options } : {})
  }
}

function validateMission(value: unknown): RavelMission {
  if (!isRecord(value) || !isString(value.goal)) throw new Error('invalid ravel mission')
  return {
    goal: value.goal,
    context: validateStringArray(value.context, 'ravel mission context'),
    constraints: validateStringArray(value.constraints, 'ravel mission constraints'),
    acceptanceCriteria: validateStringArray(
      value.acceptanceCriteria,
      'ravel mission acceptanceCriteria'
    ),
    assumptions: validateStringArray(value.assumptions, 'ravel mission assumptions')
  }
}

function validateBrief(value: unknown, index: number): RavelBrief {
  if (!isRecord(value)) throw new Error(`invalid ravel brief at index ${index}`)
  if (
    !isString(value.id) ||
    !isString(value.title) ||
    !isChildRole(value.role) ||
    !isHarness(value.harness) ||
    !isStringOrNull(value.model ?? null) ||
    !isBriefPhase(value.phase) ||
    !isString(value.goal) ||
    !isString(value.expectedOutput) ||
    !isStringOrNull(value.contextExceptionReason)
  ) {
    throw new Error(`invalid ravel brief at index ${index}`)
  }
  return {
    id: value.id,
    title: value.title,
    role: value.role,
    harness: value.harness,
    model: (value.model as string | null | undefined) ?? null,
    phase: value.phase,
    goal: value.goal,
    relevantContext: validateStringArray(value.relevantContext, 'ravel brief relevantContext'),
    constraints: validateStringArray(value.constraints, 'ravel brief constraints'),
    acceptanceCriteria: validateStringArray(value.acceptanceCriteria, 'ravel brief acceptanceCriteria'),
    doNotTouch: validateStringArray(value.doNotTouch, 'ravel brief doNotTouch'),
    expectedOutput: value.expectedOutput,
    escalationConditions: validateStringArray(
      value.escalationConditions,
      'ravel brief escalationConditions'
    ),
    dependsOn: validateStringArray(value.dependsOn, 'ravel brief dependsOn'),
    contextExceptionReason: value.contextExceptionReason
  }
}

function validatePlan(value: unknown): RavelPlan | null {
  if (value === null) return null
  if (
    !isRecord(value) ||
    !isNumber(value.revision) ||
    !isNumber(value.createdAt) ||
    !Array.isArray(value.briefs) ||
    !isNumberOrNull(value.approvedAt) ||
    !isNumberOrNull(value.approvedRevision)
  ) {
    throw new Error('invalid ravel plan')
  }
  return {
    revision: value.revision,
    createdAt: value.createdAt,
    sourceMessageIds: validateStringArray(value.sourceMessageIds, 'ravel plan sourceMessageIds'),
    // Absent on every plan written before orientation existed; never required.
    orientation: clipOrientation(value.orientation),
    mission: validateMission(value.mission),
    briefs: value.briefs.map(validateBrief),
    approvedAt: value.approvedAt,
    approvedRevision: value.approvedRevision
  }
}

function isRavelUsage(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (!isRecord(value)) return false
  return isNumber(value.inputTokens) && isNumber(value.outputTokens) && isNumberOrNull(value.costUsd ?? null)
}

function normalizeUsage(value: unknown): RavelUsage {
  if (!isRecord(value)) return { ...EMPTY_RAVEL_USAGE }
  return {
    inputTokens: isNumber(value.inputTokens) ? value.inputTokens : 0,
    outputTokens: isNumber(value.outputTokens) ? value.outputTokens : 0,
    costUsd: isNumber(value.costUsd) ? value.costUsd : null
  }
}

function validateDispatch(value: unknown, index: number): RavelDispatchRecord {
  if (!isRecord(value)) throw new Error(`invalid ravel dispatch at index ${index}`)
  if (
    !isString(value.briefId) ||
    !isNumber(value.planRevision) ||
    !isStringOrNull(value.sessionId) ||
    !isString(value.branch) ||
    !isString(value.worktreePath) ||
    !isDispatchStatus(value.status) ||
    !isNumber(value.startedAt)
  ) {
    throw new Error(`invalid ravel dispatch at index ${index}`)
  }
  return {
    briefId: value.briefId,
    planRevision: value.planRevision,
    sessionId: value.sessionId,
    branch: value.branch,
    worktreePath: value.worktreePath,
    status: value.status,
    startedAt: value.startedAt,
    // Legacy records predate both fields; null means "unknown", which the insight
    // collector treats as a dispatch to skip rather than one with no changes.
    endedAt: isNumber(value.endedAt) ? value.endedAt : null,
    baseCommit: isString(value.baseCommit) ? value.baseCommit : null,
    usage: normalizeUsage(value.usage),
    report: isStringOrNull(value.report ?? null)
      ? ((value.report as string | null | undefined) ?? null)
      : null,
    contextRequests: isNumber(value.contextRequests) ? value.contextRequests : 0,
    verification: normalizeVerification(value.verification)
  }
}

/** Absent on every dispatch written before verification existed; never required. */
function normalizeVerification(value: unknown): DispatchVerification | null {
  if (!isRecord(value) || !isBoolean(value.ok) || !isString(value.output)) return null
  return { ok: value.ok, output: value.output }
}

function validateRavel(value: unknown, index: number): RavelConfig {
  if (!isRecord(value)) throw new Error(`invalid ravel record at index ${index}`)
  if (
    !isString(value.id) ||
    !isString(value.name) ||
    !isString(value.repoId) ||
    !isString(value.repoPath) ||
    !isHarness(value.harness) ||
    !isStringOrNull(value.model ?? null) ||
    !isNumber(value.maxChildren) ||
    !isBoolean(value.allowRisky) ||
    !isRavelStatus(value.status) ||
    !isRavelActivity(value.activity) ||
    !isStringOrNull(value.managerSessionId) ||
    !Array.isArray(value.messages) ||
    !Array.isArray(value.dispatches) ||
    !isNumber(value.createdAt) ||
    !isStringOrNull(value.error) ||
    !isRavelUsage(value.usage ?? null)
  ) {
    throw new Error(`invalid ravel record at index ${index}`)
  }
  return {
    id: value.id,
    name: value.name,
    repoId: value.repoId,
    repoPath: value.repoPath,
    harness: value.harness,
    model: (value.model as string | null | undefined) ?? null,
    maxChildren: value.maxChildren,
    allowRisky: value.allowRisky,
    status: value.status,
    activity: value.activity,
    managerSessionId: value.managerSessionId,
    messages: value.messages.map(validateMessage),
    plan: validatePlan(value.plan),
    dispatches: value.dispatches.map(validateDispatch),
    createdAt: value.createdAt,
    error: value.error,
    usage: normalizeUsage(value.usage)
  }
}

const INSIGHT_CATEGORIES: Record<string, true | undefined> = {
  scope: true,
  coordination: true,
  verification: true,
  cost: true,
  progress: true
}

const INSIGHT_SEVERITIES: Record<string, true | undefined> = {
  info: true,
  warning: true,
  critical: true
}

function validateInsight(value: unknown, label: string): Insight {
  if (
    !isRecord(value) ||
    !isString(value.ruleId) ||
    !INSIGHT_CATEGORIES[String(value.category)] ||
    !INSIGHT_SEVERITIES[String(value.severity)] ||
    !isString(value.message) ||
    !isString(value.dedupeKey) ||
    !isNumber(value.shownAt)
  ) {
    throw new Error(`invalid ${label}`)
  }
  return {
    ruleId: value.ruleId,
    category: value.category as Insight['category'],
    severity: value.severity as Insight['severity'],
    message: value.message,
    dedupeKey: value.dedupeKey,
    shownAt: value.shownAt
  }
}

/**
 * Absent insights are a pre-mascot store and normalize to empty; present-but-malformed
 * throws, exactly like the Ravel and roundtable validators. Silently resetting would
 * let a corrupt file quietly re-show every observation the user already dismissed.
 */
function validateInsightState(value: unknown): InsightState {
  if (value === undefined) return cloneJson(EMPTY_INSIGHT_STATE)
  if (
    !isRecord(value) ||
    !isNumber(value.lastGlobalShownAt) ||
    !isRecord(value.lastShownByRule) ||
    !Array.isArray(value.seen)
  ) {
    throw new Error('invalid insights')
  }

  const lastShownByRule: Record<string, number> = {}
  for (const [ruleId, shownAt] of Object.entries(value.lastShownByRule)) {
    if (!isNumber(shownAt)) throw new Error(`invalid insight rule timestamp for ${ruleId}`)
    lastShownByRule[ruleId] = shownAt
  }

  return {
    current:
      value.current === undefined || value.current === null
        ? null
        : validateInsight(value.current, 'current insight'),
    lastGlobalShownAt: value.lastGlobalShownAt,
    lastShownByRule,
    // Trimmed on read as well as write: an oversized ring from an older build must
    // not grow without bound just because it survived a load.
    seen: value.seen
      .map((entry) => {
        if (!isRecord(entry) || !isString(entry.dedupeKey) || !isNumber(entry.shownAt)) {
          throw new Error('invalid seen insight')
        }
        return { dedupeKey: entry.dedupeKey, shownAt: entry.shownAt }
      })
      .slice(-INSIGHT_SEEN_LIMIT)
  }
}

function validateRoundtableList(value: unknown): RoundtableConfig[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('invalid roundtables')
  return value.map(validateRoundtable)
}

function isRoundtableStatus(value: unknown): value is RoundtableConfig['status'] {
  return (
    value === 'idle' ||
    value === 'running' ||
    value === 'paused' ||
    value === 'concluded' ||
    value === 'error'
  )
}

function validateRoundtable(value: unknown, index: number): RoundtableConfig {
  if (!isRecord(value)) throw new Error(`invalid roundtable at index ${index}`)
  if (
    !isString(value.id) ||
    !isString(value.name) ||
    !isString(value.repoId) ||
    !isString(value.repoPath) ||
    !isString(value.topic) ||
    !isNumber(value.maxTurns) ||
    !isNumber(value.createdAt) ||
    !isRoundtableStatus(value.status) ||
    !isStringOrNull(value.conclusion ?? null) ||
    !isStringOrNull(value.error ?? null) ||
    !Array.isArray(value.seats) ||
    !Array.isArray(value.turns)
  ) {
    throw new Error(`invalid roundtable at index ${index}`)
  }
  return {
    id: value.id,
    name: value.name,
    repoId: value.repoId,
    repoPath: value.repoPath,
    topic: value.topic,
    seats: value.seats.map((seat, seatIndex) => validateRoundtableSeat(seat, index, seatIndex)),
    turns: value.turns.map((turn, turnIndex) => validateRoundtableTurn(turn, index, turnIndex)),
    maxTurns: Math.round(value.maxTurns),
    status: value.status,
    conclusion: (value.conclusion as string | null | undefined) ?? null,
    error: (value.error as string | null | undefined) ?? null,
    usage: normalizeUsage(value.usage),
    createdAt: value.createdAt
  }
}

function validateRoundtableSeat(value: unknown, index: number, seatIndex: number): RoundtableSeat {
  if (!isRecord(value) || !isString(value.id) || !isString(value.name) || !isString(value.stance)) {
    throw new Error(`invalid roundtable seat ${seatIndex} at index ${index}`)
  }
  if (!isHarness(value.harness) || !isStringOrNull(value.model ?? null)) {
    throw new Error(`invalid roundtable seat ${seatIndex} at index ${index}`)
  }
  return {
    id: value.id,
    name: value.name,
    harness: value.harness,
    model: (value.model as string | null | undefined) ?? null,
    stance: value.stance
  }
}

function validateRoundtableTurn(value: unknown, index: number, turnIndex: number): RoundtableTurn {
  if (!isRecord(value) || !isString(value.id) || !isString(value.body) || !isNumber(value.createdAt)) {
    throw new Error(`invalid roundtable turn ${turnIndex} at index ${index}`)
  }
  if (value.seatId !== null && !isString(value.seatId)) {
    throw new Error(`invalid roundtable turn ${turnIndex} at index ${index}`)
  }
  return {
    id: value.id,
    seatId: value.seatId,
    body: value.body,
    createdAt: value.createdAt,
    usage: normalizeUsage(value.usage)
  }
}

/**
 * A table cannot still be talking after a restart: the process that was
 * running its turns is gone. Paused is the truthful state, and the operator
 * can resume it.
 */
function interruptRunningRoundtable(cfg: RoundtableConfig): RoundtableConfig {
  return cfg.status === 'running' ? { ...cfg, status: 'paused' } : cfg
}

function validateRavelList(value: unknown): RavelConfig[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('invalid ravel')
  return value.map(validateRavel)
}

function validateLegacyArgus(value: unknown, index: number): LegacyArgusConfig {
  if (!isRecord(value)) throw new Error(`invalid legacy argus record at index ${index}`)
  if (
    !isString(value.id) ||
    !isString(value.name) ||
    !isString(value.repoId) ||
    !isString(value.repoPath) ||
    !isHarness(value.harness) ||
    !isString(value.mission) ||
    !isNumber(value.maxChildren) ||
    !isBoolean(value.allowRisky) ||
    !isString(value.status) ||
    !isStringOrNull(value.managerSessionId) ||
    !isNumber(value.createdAt)
  ) {
    throw new Error(`invalid legacy argus record at index ${index}`)
  }
  return {
    id: value.id,
    name: value.name,
    repoId: value.repoId,
    repoPath: value.repoPath,
    harness: value.harness,
    mission: value.mission,
    maxChildren: value.maxChildren,
    allowRisky: value.allowRisky,
    status: value.status,
    managerSessionId: value.managerSessionId,
    createdAt: value.createdAt
  }
}

function migrationMessages(argus: LegacyArgusConfig): RavelConfig['messages'] {
  const messages: RavelConfig['messages'] = [
    {
      id: `${argus.id}-migration-system`,
      author: 'system',
      body: 'Migrated from legacy Argus orchestration into Ravel.',
      createdAt: argus.createdAt,
      delivery: 'delivered'
    }
  ]
  if (argus.mission.length > 0) {
    messages.push({
      id: `${argus.id}-migration-user`,
      author: 'user',
      body: argus.mission,
      createdAt: argus.createdAt,
      delivery: 'delivered'
    })
  }
  return messages
}

function migrateArgus(argus: LegacyArgusConfig): RavelConfig {
  return {
    id: argus.id,
    name: argus.name,
    repoId: argus.repoId,
    repoPath: argus.repoPath,
    harness: argus.harness,
    model: null,
    maxChildren: argus.maxChildren,
    allowRisky: argus.allowRisky,
    status: 'paused',
    activity: 'idle',
    managerSessionId: null,
    messages: migrationMessages(argus),
    plan: null,
    dispatches: [],
    createdAt: argus.createdAt,
    error: null,
    usage: { ...EMPTY_RAVEL_USAGE }
  }
}

function normalizeStoreShape(parsed: unknown): { shape: StoreShapeV2; migrated: boolean } {
  if (!isRecord(parsed)) throw new Error('invalid store root')
  if (parsed.schemaVersion === 2) {
    return {
      migrated: false,
      shape: {
        schemaVersion: 2,
        repos: validateRepos(parsed.repos),
        settings: mergeSettings(parsed.settings),
        worktrees: validateWorktrees(parsed.worktrees),
        ravel: validateRavelList(parsed.ravel).map(interruptLiveDispatchesForRestart),
        roundtables: validateRoundtableList(parsed.roundtables).map(interruptRunningRoundtable),
        insights: validateInsightState(parsed.insights)
      }
    }
  }
  if (Array.isArray(parsed.argus)) {
    return {
      migrated: true,
      shape: {
        schemaVersion: 2,
        repos: validateRepos(parsed.repos),
        settings: mergeSettings(parsed.settings),
        worktrees: validateWorktrees(parsed.worktrees),
        ravel: parsed.argus.map(validateLegacyArgus).map(migrateArgus),
        insights: cloneJson(EMPTY_INSIGHT_STATE)
      }
    }
  }
  throw new Error('unsupported store schema')
}

function validateStoreShapeV2(value: StoreShapeV2): StoreShapeV2 {
  return {
    schemaVersion: 2,
    repos: validateRepos(value.repos),
    settings: mergeSettings(value.settings),
    worktrees: validateWorktrees(value.worktrees),
    ravel: validateRavelList(value.ravel),
    roundtables: validateRoundtableList(value.roundtables),
    insights: validateInsightState(value.insights)
  }
}

function applySettingsPatch(current: Settings, patch: Partial<Settings>): Settings {
  if (!isRecord(patch)) throw new Error('invalid settings patch')
  const hooks =
    patch.hooks === undefined
      ? current.hooks
      : isRecord(patch.hooks)
        ? {
            ...current.hooks,
            ...patch.hooks,
            perRepo:
              patch.hooks.perRepo === undefined
                ? current.hooks.perRepo
                : isRecord(patch.hooks.perRepo)
                  ? { ...current.hooks.perRepo, ...patch.hooks.perRepo }
                  : patch.hooks.perRepo
          }
        : patch.hooks
  const verify =
    patch.verify === undefined
      ? current.verify
      : isRecord(patch.verify)
        ? {
            ...current.verify,
            ...patch.verify,
            perRepo:
              patch.verify.perRepo === undefined
                ? current.verify.perRepo
                : isRecord(patch.verify.perRepo)
                  ? { ...current.verify.perRepo, ...patch.verify.perRepo }
                  : patch.verify.perRepo
          }
        : patch.verify
  const harnessPaths =
    patch.harnessPaths === undefined
      ? current.harnessPaths
      : isRecord(patch.harnessPaths)
        ? { ...current.harnessPaths, ...patch.harnessPaths }
        : patch.harnessPaths
  const harnessArgs =
    patch.harnessArgs === undefined
      ? current.harnessArgs
      : isRecord(patch.harnessArgs)
        ? { ...current.harnessArgs, ...patch.harnessArgs }
        : patch.harnessArgs
  const editor =
    patch.editor === undefined
      ? current.editor
      : isRecord(patch.editor)
        ? { ...current.editor, ...patch.editor }
        : patch.editor
  return mergeSettings({
    ...current,
    ...patch,
    hooks,
    verify,
    harnessPaths,
    harnessArgs,
    editor
  })
}

function validateWorktreeMeta(
  path: string,
  meta: { repoId: string; repoPath: string; branch: string; createdAt: number }
): WorktreeRecord[string] {
  return validateWorktrees({ [path]: meta })[path]
}

function pathIdentity(value: string): string {
  const withoutTrailingSeparators = normalize(value).replace(/[\\/]+$/, '')
  return process.platform === 'win32'
    ? withoutTrailingSeparators.toLocaleLowerCase()
    : withoutTrailingSeparators
}

function sameStoredPath(left: string, right: string): boolean {
  return pathIdentity(left) === pathIdentity(right)
}

function findWorktreeKey(worktrees: WorktreeRecord, path: string): string | undefined {
  return Object.keys(worktrees).find((key) => sameStoredPath(key, path))
}

function backupPathFor(storeFile: string): string {
  const safeTimestamp = new Date().toISOString().replace(/[:.]/g, '-')
  return join(dirname(storeFile), `${basename(storeFile)}.backup-${safeTimestamp}`)
}

function persistAtomic(storeFile: string, shape: StoreShapeV2): void {
  mkdirSync(dirname(storeFile), { recursive: true })
  const tempFile = join(
    dirname(storeFile),
    `${basename(storeFile)}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`
  )
  try {
    writeFileSync(tempFile, JSON.stringify(shape, null, 2), 'utf8')
    renameSync(tempFile, storeFile)
  } catch (error) {
    try {
      if (existsSync(tempFile)) unlinkSync(tempFile)
    } catch {
      // Best effort cleanup only; the original store file has not been replaced.
    }
    throw error
  }
}

export function createStoreForPath(storeFileInput: string | (() => string)): ConductorStore {
  const resolveStoreFile = typeof storeFileInput === 'function' ? storeFileInput : () => storeFileInput
  let cache = emptyStore()
  let loadError: Error | null = null

  const load = (): StoreShapeV2 => {
    const storeFile = resolveStoreFile()
    let raw: string | null = null
    try {
      mkdirSync(dirname(storeFile), { recursive: true })
      if (!existsSync(storeFile)) {
        cache = emptyStore()
        persistAtomic(storeFile, cache)
        loadError = null
        return cloneJson(cache)
      }

      raw = readFileSync(storeFile, 'utf8')
      const { shape, migrated } = normalizeStoreShape(JSON.parse(raw))
      if (migrated) {
        writeFileSync(backupPathFor(storeFile), raw, 'utf8')
        persistAtomic(storeFile, shape)
      }
      cache = shape
      loadError = null
      return cloneJson(cache)
    } catch (error) {
      if (raw !== null) {
        try {
          copyFileSync(storeFile, backupPathFor(storeFile))
        } catch {
          /* Preserve the original load error even if backup storage fails. */
        }
      }
      loadError = failLoad(error)
      throw loadError
    }
  }

  const commit = (next: StoreShapeV2): StoreShapeV2 => {
    // The cache after a failed load is an empty store, not the user's data.
    // Writing it back would overwrite a file we could not even parse and turn
    // a recoverable read error into permanent loss, so refuse until a load
    // succeeds. `getLoadError()` is what the UI reports.
    if (loadError) {
      throw new Error(`refusing to write: store failed to load (${loadError.message})`)
    }
    const validated = validateStoreShapeV2(next)
    persistAtomic(resolveStoreFile(), validated)
    cache = validated
    return cache
  }

  return {
    init: load,
    getLoadError: () => loadError,
    reset: (): void => {
      const next = emptyStore()
      persistAtomic(resolveStoreFile(), next)
      cache = next
      loadError = null
    },
    exportTo: (destinationFile: string): void => {
      copyFileSync(resolveStoreFile(), destinationFile)
    },
    importFrom: (sourceFile: string): void => {
      let imported: StoreShapeV2
      try {
        const raw = readFileSync(sourceFile, 'utf8')
        imported = normalizeStoreShape(JSON.parse(raw)).shape
      } catch (error) {
        throw failLoad(error)
      }
      persistAtomic(resolveStoreFile(), imported)
      cache = imported
      loadError = null
    },
    getRepos: (): Repo[] => cloneJson(cache.repos),
    addRepo: (repo: Repo): Repo => {
      const validatedRepo = validateRepo(repo, 0)
      const existing = cache.repos.find((stored) => sameStoredPath(stored.path, validatedRepo.path))
      if (existing) return cloneJson(existing)
      const next = cloneJson(cache)
      next.repos = [...next.repos, validatedRepo]
      const committed = commit(next)
      return cloneJson(committed.repos[committed.repos.length - 1])
    },
    removeRepo: (id: string): void => {
      if (!isString(id)) throw new Error('invalid repo id')
      const next = cloneJson(cache)
      next.repos = next.repos.filter((repo) => repo.id !== id)
      commit(next)
    },
    getSettings: (): Settings => cloneJson(cache.settings),
    saveSettings: (patch: Partial<Settings>): Settings => {
      const next = cloneJson(cache)
      next.settings = applySettingsPatch(next.settings, patch)
      const committed = commit(next)
      return cloneJson(committed.settings)
    },
    getWorktrees: () => cloneJson(cache.worktrees),
    trackWorktree: (
      path: string,
      meta: { repoId: string; repoPath: string; branch: string }
    ): void => {
      if (!isString(path)) throw new Error('invalid worktree path')
      const validatedMeta = validateWorktreeMeta(path, { ...meta, createdAt: Date.now() })
      const next = cloneJson(cache)
      const existingKey = findWorktreeKey(next.worktrees, path)
      next.worktrees[existingKey ?? path] = validatedMeta
      commit(next)
    },
    untrackWorktree: (path: string): void => {
      if (!isString(path)) throw new Error('invalid worktree path')
      const next = cloneJson(cache)
      const existingKey = findWorktreeKey(next.worktrees, path)
      if (existingKey !== undefined) delete next.worktrees[existingKey]
      commit(next)
    },
    getRavel: (): RavelConfig[] => cloneJson(cache.ravel),
    getRavelById: (id: string): RavelConfig | undefined => {
      const ravel = cache.ravel.find((item) => item.id === id)
      return ravel ? cloneJson(ravel) : undefined
    },
    addRavel: (cfg: RavelConfig): RavelConfig => {
      const validatedRavel = validateRavel(cfg, 0)
      const next = cloneJson(cache)
      next.ravel = [...next.ravel, validatedRavel]
      const committed = commit(next)
      return cloneJson(committed.ravel[committed.ravel.length - 1])
    },
    replaceRavel: (id: string, cfg: RavelConfig): RavelConfig | undefined => {
      const index = cache.ravel.findIndex((ravel) => ravel.id === id)
      if (index === -1) return undefined
      const validatedRavel = validateRavel(cfg, index)
      const next = cloneJson(cache)
      next.ravel[index] = validatedRavel
      const committed = commit(next)
      return cloneJson(committed.ravel[index])
    },
    updateRavel: (id: string, patch: Partial<RavelConfig>): RavelConfig | undefined => {
      const index = cache.ravel.findIndex((item) => item.id === id)
      if (index === -1) return undefined
      const validatedRavel = validateRavel({ ...cache.ravel[index], ...patch }, index)
      const next = cloneJson(cache)
      next.ravel[index] = validatedRavel
      const committed = commit(next)
      return cloneJson(committed.ravel[index])
    },
    removeRavel: (id: string): void => {
      if (!isString(id)) throw new Error('invalid ravel id')
      const next = cloneJson(cache)
      next.ravel = next.ravel.filter((ravel) => ravel.id !== id)
      commit(next)
    },
    listRoundtables: (): RoundtableConfig[] => cloneJson(cache.roundtables ?? []),
    getRoundtable: (id: string): RoundtableConfig | undefined => {
      const found = (cache.roundtables ?? []).find((item) => item.id === id)
      return found ? cloneJson(found) : undefined
    },
    addRoundtable: (cfg: RoundtableConfig): RoundtableConfig => {
      const validated = validateRoundtable(cfg, 0)
      const next = cloneJson(cache)
      next.roundtables = [...(next.roundtables ?? []), validated]
      const committed = commit(next)
      const saved = committed.roundtables ?? []
      return cloneJson(saved[saved.length - 1])
    },
    replaceRoundtable: (id: string, cfg: RoundtableConfig): RoundtableConfig | undefined => {
      const list = cache.roundtables ?? []
      const index = list.findIndex((item) => item.id === id)
      if (index === -1) return undefined
      const validated = validateRoundtable(cfg, index)
      const next = cloneJson(cache)
      next.roundtables = [...(next.roundtables ?? [])]
      next.roundtables[index] = validated
      const committed = commit(next)
      return cloneJson((committed.roundtables ?? [])[index])
    },
    removeRoundtable: (id: string): void => {
      if (!isString(id)) throw new Error('invalid roundtable id')
      const next = cloneJson(cache)
      next.roundtables = (next.roundtables ?? []).filter((item) => item.id !== id)
      commit(next)
    },
    getInsightState: (): InsightState => cloneJson(cache.insights ?? EMPTY_INSIGHT_STATE),
    saveInsightState: (state: InsightState): InsightState => {
      const next = cloneJson(cache)
      next.insights = validateInsightState(state)
      return cloneJson(commit(next).insights ?? EMPTY_INSIGHT_STATE)
    }
  }
}

export const store = createStoreForPath(defaultStoreFile)
