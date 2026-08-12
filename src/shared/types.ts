// Shared types between main, preload, and renderer.

export type HarnessId = 'claude' | 'codex' | 'zai'

export interface HarnessInfo {
  id: HarnessId
  label: string
  provider: string
  /** Short tagline shown in the picker. */
  blurb: string
  accent: string
}

export const HARNESS_INFO: Record<HarnessId, HarnessInfo> = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    provider: 'Anthropic',
    blurb: 'claude — Anthropic coding agent',
    accent: '#d97757'
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    provider: 'OpenAI',
    blurb: 'codex — OpenAI coding agent',
    accent: '#10a37f'
  },
  zai: {
    id: 'zai',
    label: 'ZAI',
    provider: 'Z.AI · GLM',
    blurb: 'omp — ZAI/GLM coding agent',
    accent: '#ff9500'
  }
}

/** A resolved, spawnable harness command. */
export interface ResolvedHarness {
  /** null for a resolved shell: a terminal session runs no agent. */
  id: HarnessId | null
  command: string
  args: string[]
  /** Extra env the resolver requires (e.g. running Electron's binary as Node). */
  env?: Record<string, string>
  /** Where the binary was found. */
  resolvedFrom: string
}

/**
 * A terminal session has no harness. It still needs a label, a provider line and
 * an accent, so the display side treats "no agent" as an identity of its own
 * rather than special-casing null at every call site.
 */
export const TERMINAL_INFO: Omit<HarnessInfo, 'id'> = {
  label: 'Terminal',
  provider: 'Local shell',
  blurb: 'your shell — no agent',
  accent: '#7d8697'
}

export function agentInfo(harness: HarnessId | null): Omit<HarnessInfo, 'id'> {
  return harness === null ? TERMINAL_INFO : HARNESS_INFO[harness]
}

export interface HarnessAvailability {
  id: HarnessId
  info: HarnessInfo
  available: boolean
  resolved?: ResolvedHarness
  reason?: string
}

export type SessionStatus =
  | 'starting'
  | 'running'
  | 'needs-input'
  | 'closed'
  | 'error'

export type RavelRole =
  | 'orchestrator'
  | 'lead-engineer'
  | 'auditor'
  | 'minor-task'
  | 'researcher'
  | 'test-engineer'
  | 'security-engineer'
  | 'performance-engineer'
  | 'release-engineer'
export type ChildRavelRole = Exclude<RavelRole, 'orchestrator'>

/**
 * There is no manager session kind: the Ravel manager is a headless per-event
 * invocation, not a long-lived pty, so nothing ever constructs one.
 */
export type SessionKind = 'normal' | 'ravel-child'

export interface Repo {
  id: string
  path: string
  name: string
  addedAt: number
}

export interface WorktreeInfo {
  path: string
  branch: string | null
  head: string | null
  bare: boolean
  detached: boolean
  /** True if Conductor created this worktree (tracked). */
  conductor?: boolean
}

export interface MergePreviewOverlap {
  branch: string
  files: string[]
}

export interface MergePreviewEntry {
  branch: string
  /** Paths this branch changes relative to the merge base with `baseBranch`. */
  files: string[]
  /** null when the trial merge could not run — see `error`; never guessed. */
  conflictsWithBase: boolean | null
  conflictPaths: string[]
  /** Other branches in the previewed set that touch at least one of the same files. */
  overlaps: MergePreviewOverlap[]
  error: string | null
}

export type MergePreviewResult =
  | { ok: true; baseBranch: string; entries: MergePreviewEntry[] }
  | { ok: false; error: string }

export interface MergeOptions {
  /** Land the branch as a single commit instead of a merge commit. */
  squash?: boolean
  message?: string
}

export interface MergeLanded {
  ok: true
  branch: string
  /** New commit on the base, or null when the base already contained the work. */
  commit: string | null
  alreadyMerged: boolean
  files: string[]
  /** Non-fatal problem after the work landed, e.g. the previous branch could not be restored. */
  warning: string | null
}

export interface MergeFailure {
  ok: false
  error: string
  paths?: string[]
  /**
   * Whether the repository was confirmed back at the tip and branch it started
   * from — re-read after the recovery ran, not inferred from an exit code.
   * False means the operator has to look before doing anything else.
   */
  restored: boolean
}

export type MergeBranchResult = MergeLanded | MergeFailure

export type DeleteBranchResult = { ok: true; branch: string } | { ok: false; error: string }

interface SessionBase {
  id: string
  repoId: string
  repoPath: string
  worktreePath: string
  branch: string
  status: SessionStatus
  title: string | null
  initialPrompt: string | null
  createdAt: number
  /** ISO mark of last output, used by status heuristics. */
  lastActivityAt: number
}

export type Session =
  | (SessionBase & {
      kind: 'normal'
      /**
       * null is a TERMINAL session: the pty runs your own shell instead of an
       * agent CLI. Modelled here rather than as a fourth HarnessId because a
       * shell has no model catalogue, cannot be probed, and must never be
       * offered to a Ravel brief.
       */
      harness: HarnessId | null
      parentId: null
      ravelId: null
      ravelRole: null
      briefId: null
    })
  | (SessionBase & {
      kind: 'ravel-child'
      /**
       * null is a HUMAN SEAT: the operator took this brief themselves and works
       * it in a shell. The manager never chooses one — it can only dispatch an
       * agent it can invoke — so a seat is always claimed deliberately.
       */
      harness: HarnessId | null
      /** Ravel children have no parent session: the manager is a per-turn invocation. */
      parentId: null
      ravelId: string
      ravelRole: ChildRavelRole
      briefId: string
    })


/**
 * A bounded, screen-faithful replay of one session's raw PTY output. Returned
 * by the Core for reattachment; the buffer carries ANSI sequences verbatim so a
 * reconnecting terminal renders the exact screen state. `generation` is the
 * monotonic count of PTY data chunks accepted before this snapshot.
 */
export interface SessionSnapshot {
  sessionId: string
  /** Raw PTY text, including ANSI escape sequences, bounded by the Core. */
  buffer: string
  /** Number of PTY data chunks accepted before this snapshot. */
  generation: number
  cols: number
  rows: number
  truncated: boolean
}
export interface EditorSettings {
  /** Monaco font family. Empty string = platform default monospace. */
  fontFamily: string
  fontSize: number
  wordWrap: boolean
  minimap: boolean
  /** Ctrl+Click same-file go-to-definition. */
  gotoDefinition: boolean
}

/**
 * Palette only. Translucency is the orthogonal `acrylic` setting, so either
 * palette can run flat or glassy.
 */
export type ConductorTheme = 'flat' | 'terminal'

export const CONDUCTOR_THEMES: readonly ConductorTheme[] = ['flat', 'terminal']


/**
 * Static fallback catalogue per harness. Each harness only accepts its own
 * CLI's names: claude takes aliases, codex takes gpt ids, and the ZAI harness
 * (omp) takes fully-qualified `provider/model` ids.
 *
 * These lists are hand-written and go stale on every vendor release, so they
 * are only what the UI shows when live enumeration is unavailable —
 * `resolveModelCatalogue` in `src/main/harness.ts` asks the installed CLI
 * first and falls back here.
 */
export const HARNESS_MODEL_OPTIONS: Record<HarnessId, readonly string[]> = {
  claude: ['opus', 'sonnet', 'haiku', 'claude-opus-5', 'claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5'],
  codex: ['gpt-5.5', 'gpt-5.4', 'gpt-5.3-codex', 'gpt-5-codex', 'gpt-5.2-codex', 'gpt-5.1-codex'],
  zai: [
    'zai/glm-5.2',
    'zai/glm-5.2-fast',
    'zai/glm-5.1',
    'zai/glm-5',
    'zai/glm-5-turbo',
    'zai/glm-4.7',
    'zai/glm-4.7-flash',
    'zai/glm-4.6',
    'anthropic/claude-opus-5',
    'anthropic/claude-sonnet-4-5',
    'openai/gpt-5.5',
    'google/gemini-3-flash-preview'
  ]
}

/**
 * What one harness can run, and where the list came from.
 *
 * Produced by `resolveModelCatalogue` in `src/main/harness.ts` and carried
 * across IPC, so it lives here beside the other harness types rather than in
 * main.
 */
export interface HarnessCatalogue {
  models: readonly string[]
  /** false when this is the static fallback rather than the installed CLI's own list. */
  discovered: boolean
}

/**
 * The fallback catalogue as a map. This is what the renderer shows before the
 * live probe has answered, and what it keeps if the probe never does.
 */
export const STATIC_MODEL_CATALOGUES: Record<HarnessId, HarnessCatalogue> = {
  claude: { models: HARNESS_MODEL_OPTIONS.claude, discovered: false },
  codex: { models: HARNESS_MODEL_OPTIONS.codex, discovered: false },
  zai: { models: HARNESS_MODEL_OPTIONS.zai, discovered: false }
}

/** What a model dropdown renders, once the stored value is accounted for. */
export interface ModelOptions {
  values: readonly string[]
  /** The stored model the catalogue does not offer, or null. Always first in `values`. */
  unlisted: string | null
}

/**
 * Options for one model dropdown.
 *
 * A stored model missing from the catalogue is prepended rather than dropped:
 * a `<select>` whose `value` matches no `<option>` renders as its first entry,
 * so omitting the stored model would show the user a different model than the
 * one that will actually run, and commit that lie on the next save. Marking it
 * `unlisted` lets the UI say the harness no longer offers it.
 */
export function modelOptionsFor(
  catalogue: HarnessCatalogue | undefined,
  selected: string
): ModelOptions {
  const models = catalogue?.models ?? []
  if (selected.length === 0 || models.includes(selected)) return { values: models, unlisted: null }
  return { values: [selected, ...models], unlisted: selected }
}

/** omp reasoning levels, appended to a model id as `model:level`. */
export type ThinkingLevel = 'auto' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  'auto',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh'
]

/** Only the omp-backed harness understands the `:level` suffix. */
export function harnessSupportsBehavior(harness: HarnessId): boolean {
  return harness === 'zai'
}

/** Compose what actually goes to `--model`. */
export function composeModel(model: string, behavior: ThinkingLevel | undefined): string {
  if (!model) return ''
  if (!behavior || behavior === 'auto') return model
  return `${model}:${behavior}`
}

/** Split a stored value back into its dropdown parts. */
export function splitModel(value: string | null | undefined): { model: string; behavior: ThinkingLevel } {
  if (!value) return { model: '', behavior: 'auto' }
  const marker = value.lastIndexOf(':')
  if (marker > 0) {
    const tail = value.slice(marker + 1) as ThinkingLevel
    if (THINKING_LEVELS.includes(tail)) return { model: value.slice(0, marker), behavior: tail }
  }
  return { model: value, behavior: 'auto' }
}


/**
 * Role presets for a standalone session. Ravel assigns roles to its own
 * children through the plan; this is the same vocabulary for sessions you
 * launch yourself, applied as a prompt preamble rather than Ravel wiring.
 */
export type SessionBehavior = 'none' | ChildRavelRole

export const SESSION_BEHAVIORS: readonly SessionBehavior[] = [
  'none',
  'lead-engineer',
  'auditor',
  'minor-task',
  'researcher',
  'test-engineer',
  'security-engineer',
  'performance-engineer',
  'release-engineer'
]

export const BEHAVIOR_LABELS: Record<SessionBehavior, string> = {
  none: 'No role',
  'lead-engineer': 'Lead Engineer',
  auditor: 'Auditor',
  'minor-task': 'Minor Task',
  researcher: 'Researcher',
  'test-engineer': 'Test Engineer',
  'security-engineer': 'Security Engineer',
  'performance-engineer': 'Performance Engineer',
  'release-engineer': 'Release Engineer'
}

export const BEHAVIOR_BRIEFS: Record<Exclude<RavelRole, 'orchestrator'>, string> = {
  'lead-engineer':
    'ROLE: Lead Engineer\n\nYou own the implementation. Read before editing, follow existing conventions, keep changes tight, and verify with the project\u2019s own tests and typechecks before claiming completion.',
  auditor:
    'ROLE: Auditor\n\nYou review, you do not implement. Report concrete defects with file:line evidence, ranked by severity. Do not modify files unless explicitly asked.',
  'minor-task':
    'ROLE: Minor Task\n\nYou handle one narrow, well-scoped change. Do exactly what is asked, touch nothing else, and stop when the single task is done.',
  researcher:
    'ROLE: Researcher\n\nYou investigate APIs, libraries, repository patterns, and technical options. Do not edit files; return evidence and concrete recommendations.',
  'test-engineer':
    'ROLE: Test Engineer\n\nYou design and run focused tests for behavior, boundaries, and regressions. Report failures with exact reproduction and avoid unrelated edits.',
  'security-engineer':
    'ROLE: Security Engineer\n\nYou review trust boundaries, permissions, secrets, injection paths, and unsafe changes. Report concrete risks with evidence and remediation.',
  'performance-engineer':
    'ROLE: Performance Engineer\n\nYou profile CPU, memory, I/O, latency, and concurrency. Measure before changing code and report the bottleneck and the verified improvement.',
  'release-engineer':
    'ROLE: Release Engineer\n\nYou handle packaging, migrations, changelogs, deployment checks, and release readiness. Verify artifacts and preserve a reproducible release record.'
}

/** Prefix a prompt with the selected role brief. */
export function applyBehaviorToPrompt(behavior: SessionBehavior, prompt: string): string {
  if (behavior === 'none') return prompt
  const brief = BEHAVIOR_BRIEFS[behavior]
  return prompt.trim().length > 0 ? `${brief}\n\nTASK:\n${prompt.trim()}` : brief
}


/** One file touched by a session, as observed in its worktree. */
export interface SessionActivityEntry {
  id: string
  sessionId: string
  path: string
  kind: 'added' | 'edited' | 'removed'
  ts: number
}

/** Panels the user can show or hide from the View menu. */
export type PanelId = 'projects' | 'sessions' | 'activity' | 'plan' | 'fleet' | 'log' | 'manager'

export const PANEL_IDS: readonly PanelId[] = ['projects', 'sessions', 'activity', 'plan', 'fleet', 'log', 'manager']

export const PANEL_LABELS: Record<PanelId, string> = {
  projects: 'Repositories rail',
  sessions: 'Sessions rail',
  activity: 'Activity tab',
  plan: 'Plan tab',
  fleet: 'Fleet tab',
  log: 'Log tab',
  manager: 'Manager tab'
}

/** Absent means visible, so older stores keep every panel. */
export function panelVisible(panels: Partial<Record<PanelId, boolean>>, id: PanelId): boolean {
  return panels[id] !== false
}

/** Panels the Ravel rail renders as tabs, in natural order. */
export type RailPanelId = Extract<PanelId, 'activity' | 'plan' | 'fleet' | 'log' | 'manager'>

export const RAIL_PANEL_IDS: readonly RailPanelId[] = ['activity', 'plan', 'fleet', 'log', 'manager']

/**
 * Applies a user-chosen order to a natural-order panel list. Ids the order does
 * not mention keep their natural position behind the ones it does, so an absent
 * or stale partial order still renders every panel exactly once.
 */
export function orderPanels<T extends PanelId>(ids: readonly T[], order: readonly PanelId[]): T[] {
  const ranked = ids.filter((id) => order.includes(id)).sort((a, b) => order.indexOf(a) - order.indexOf(b))
  return [...ranked, ...ids.filter((id) => !order.includes(id))]
}

/**
 * Which side of the conversation a rail panel is docked to.
 *
 * Two rails, not a free-floating window manager: panels the operator wants to
 * watch together (Fleet while the Manager talks) sit opposite each other, and
 * everything else stays a tab. Absent means the right rail, so an older store
 * keeps the single-rail layout it was written with.
 */
export type PanelDock = 'left' | 'right'

export const PANEL_DOCKS: readonly PanelDock[] = ['left', 'right']

export function panelDock(dock: Partial<Record<RailPanelId, PanelDock>>, id: RailPanelId): PanelDock {
  return dock[id] === 'left' ? 'left' : 'right'
}

/** Draggable panel widths in pixels, keyed by panel. */
export type ResizablePanelId = 'projects' | 'sessions' | 'ravelRail' | 'ravelRailLeft'

export const PANEL_SIZE_LIMITS: Record<ResizablePanelId, { min: number; max: number; default: number }> = {
  projects: { min: 160, max: 480, default: 240 },
  sessions: { min: 200, max: 560, default: 300 },
  ravelRail: { min: 260, max: 720, default: 360 },
  ravelRailLeft: { min: 260, max: 720, default: 320 }
}

export function panelWidth(sizes: Partial<Record<ResizablePanelId, number>>, id: ResizablePanelId): number {
  const limits = PANEL_SIZE_LIMITS[id]
  const stored = sizes[id]
  if (typeof stored !== 'number' || !Number.isFinite(stored)) return limits.default
  return Math.min(limits.max, Math.max(limits.min, Math.round(stored)))
}

export const ACRYLIC_INTENSITY_MIN = 0
export const ACRYLIC_INTENSITY_MAX = 100

// --- Canvas: free-floating panels on the glass workspace ---

/**
 * What a floating panel shows. Singletons exist at most once; the rest are keyed
 * by `subjectId`, so two ravels open two panels.
 */
export type CanvasPanelKind =
  | 'sessions'
  | 'work'
  | 'fleet'
  | 'session'
  | 'ravel'
  | 'roundtable'
  | 'settings'

export const CANVAS_SINGLETONS: Record<CanvasPanelKind, true | undefined> = {
  sessions: true,
  work: true,
  fleet: true,
  settings: true,
  session: undefined,
  ravel: undefined,
  roundtable: undefined
}

export interface CanvasPanel {
  /** Stable per instance: `kind` for singletons, `kind:subjectId` otherwise. */
  id: string
  kind: CanvasPanelKind
  /** The session/ravel/roundtable this panel is about. null for singletons. */
  subjectId: string | null
  x: number
  y: number
  w: number
  h: number
  /** Higher is nearer the front. Normalised on every raise so it cannot drift up. */
  z: number
  /** Collapsed to its header, keeping its place in the arrangement. */
  minimized: boolean
}

/** A named arrangement the operator can return to. */
export interface CanvasLayout {
  id: string
  name: string
  panels: CanvasPanel[]
}

export const DEFAULT_CANVAS_LAYOUT_VERSION = 1

export interface CanvasState {
  panels: CanvasPanel[]
  layouts: CanvasLayout[]
  activeLayoutId: string | null
  /** 0 = never initialized by the measured Command Centre generator. */
  defaultLayoutVersion: number
}

export const EMPTY_CANVAS: CanvasState = {
  panels: [],
  layouts: [],
  activeLayoutId: null,
  defaultLayoutVersion: 0
}

/** Below these a panel stops being usable; drags and stored values clamp to them. */
export const CANVAS_PANEL_MIN = { w: 220, h: 140 }
/** Header-only height when minimized. Must match the header in CanvasFrame. */
export const CANVAS_HEADER_H = 34

export const CANVAS_DEFAULT_SIZE: Record<CanvasPanelKind, { w: number; h: number }> = {
  sessions: { w: 246, h: 260 },
  work: { w: 246, h: 240 },
  fleet: { w: 200, h: 300 },
  session: { w: 760, h: 520 },
  ravel: { w: 900, h: 600 },
  roundtable: { w: 760, h: 560 },
  settings: { w: 680, h: 620 }
}

export function canvasPanelId(kind: CanvasPanelKind, subjectId: string | null): string {
  return CANVAS_SINGLETONS[kind] ? kind : `${kind}:${subjectId ?? ''}`
}

export const THEME_LABELS: Record<ConductorTheme, string> = {
  flat: 'Dark',
  terminal: 'Terminal'
}

export interface Settings {
  defaultHarness: HarnessId
  /** Colour palette for app chrome and surfaces. */
  theme: ConductorTheme
  /** Translucent glass surfaces, with real blur-behind where Windows allows. */
  acrylic: boolean
  /** How far the glass goes, 0 (barely tinted) to 100 (maximum blur/transparency). */
  acrylicIntensity: number
  /** User-dragged panel widths in pixels. */
  panelSizes: Partial<Record<ResizablePanelId, number>>
  /** Hidden panels; absent entries stay visible. */
  panels: Partial<Record<PanelId, boolean>>
  /** User-dragged panel order; ids absent from it keep their natural position. */
  panelOrder: PanelId[]
  /** Which rail each panel is docked to; absent entries use the right rail. */
  panelDock: Partial<Record<RailPanelId, PanelDock>>
  /** Optional explicit binary path overrides. */
  harnessPaths: Partial<Record<HarnessId, string>>
  /**
   * Default model per harness, passed as `--model <value>`. Empty/absent means
   * the harness CLI picks its own default.
   */
  harnessModels: Partial<Record<HarnessId, string>>
  /** Extra CLI args per harness. */
  harnessArgs: Partial<Record<HarnessId, string[]>>
  /**
   * Ordered vendor fallback for a Ravel MANAGER: when its harness runs dry
   * (quota, rate limit, auth failure, or an uninstalled CLI) mid-run, the
   * manager is re-pointed to the next installed harness in this list instead of
   * stalling. Empty disables fallback. Only the cheap headless manager turn is
   * re-pointed - running children are never auto-switched to another vendor.
   */
  harnessFallback: HarnessId[]
  /** Post-create worktree hook scripts. */
  hooks: {
    global: string | null
    perRepo: Record<string, string> // repoId -> script
  }
  /**
   * Command run in a child's worktree when it finishes, so the orchestrator
   * learns whether the change actually holds up rather than only what the
   * child claimed. Same shape as hooks: a global default, overridable per repo.
   */
  verify: {
    global: string | null
    perRepo: Record<string, string>
  }
  /** Register a per-user Windows Run entry to launch the background Core at sign-in. */
  autostart: boolean
  /**
   * One-time operator consent to run repo hooks and verify commands, which are
   * arbitrary user shell executed at full privilege. Default false: until the
   * operator grants consent, post-create hooks are skipped and a configured
   * verify command is treated as a failed (not-run) verification rather than
   * silently executing shell.
   */
  shellHooksConsented: boolean
  /** Root directory for created worktrees. */
  worktreeRoot: string | null
  /** Estimated-token ceiling per ravel. 0 disables the limit. */
  tokenCeilingPerRavel: number
  /** Code editor (Monaco) preferences. */
  editor: EditorSettings
  /** Floating-panel arrangement and any layouts saved from it. */
  canvas: CanvasState
}

export const DEFAULT_EDITOR_SETTINGS: EditorSettings = {
  fontFamily: "'IBM Plex Mono', 'Cascadia Code NF', Menlo, Consolas, monospace",
  fontSize: 13,
  wordWrap: true,
  minimap: false,
  gotoDefinition: true
}

export const DEFAULT_SETTINGS: Settings = {
  defaultHarness: 'claude',
  theme: 'flat',
  acrylic: true,
  acrylicIntensity: 71,
  panels: {},
  panelOrder: [],
  panelDock: {},
  panelSizes: {},
  harnessPaths: {},
  harnessModels: { zai: 'zai/glm-5.2' },
  harnessArgs: {},
  harnessFallback: ['claude', 'codex', 'zai'],
  hooks: { global: null, perRepo: {} },
  verify: { global: null, perRepo: {} },
  autostart: false,
  shellHooksConsented: false,
  worktreeRoot: null,
  tokenCeilingPerRavel: 0,
  editor: { ...DEFAULT_EDITOR_SETTINGS },
  canvas: { panels: [], layouts: [], activeLayoutId: null, defaultLayoutVersion: 0 }
}

export interface CreateWorktreeRequest {
  repoPath: string
  branch: string
  /** Create a new branch from this base. If omitted and branch exists, check it out. */
  baseBranch?: string
  /** Force-new branch even if it exists. */
  newBranch?: boolean
}

export interface CreateNormalSessionRequest {
  repoId: string
  repoPath: string
  worktreePath: string
  branch: string
  /** null spawns your shell instead of an agent CLI — a terminal session. */
  harness: HarnessId | null
  initialPrompt?: string
  /** Display name. Falls back to a truncation of the initial prompt. */
  title?: string
  /** Model override for this session; falls back to the harness default. */
  model?: string
  createWorktree?: CreateWorktreeRequest
  kind?: 'normal'
}

interface CreateSessionRequestBase {
  repoId: string
  repoPath: string
  worktreePath: string
  branch: string
  /** null spawns your shell instead of an agent CLI — a terminal session. */
  harness: HarnessId | null
  initialPrompt?: string
  /** Display name. Falls back to a truncation of the initial prompt. */
  title?: string
  /** Model override for this session; falls back to the harness default. */
  model?: string
  /** If true, create a fresh worktree at session create time. */
  createWorktree?: CreateWorktreeRequest
  /** Inject harness auto-approve flags (e.g. claude --dangerously-skip-permissions). */
  autoApprove?: boolean
  /** Extra env vars for the spawned process (e.g. CONDUCTOR_RAVEL_CAP for managers). */
  env?: Record<string, string>
}

export type CreateSessionRequest =
  | (CreateSessionRequestBase & {
      /** Session role. Defaults to 'normal'. */
      kind?: 'normal'
      parentId?: null
      ravelId?: null
      ravelRole?: null
      briefId?: null
    })
  | (CreateSessionRequestBase & {
      kind: 'ravel-child'
      /**
       * null only when the operator claimed the brief themselves. `toolSpawnChild`
       * always passes a real agent; a shell cannot be dispatched to.
       */
      harness: HarnessId | null
      parentId?: null
      ravelId: string
      ravelRole: ChildRavelRole
      briefId: string
    })

// --- Ravel: conversational orchestration across child sessions ---

export type RavelStatus = 'idle' | 'awaiting-approval' | 'running' | 'paused' | 'completed' | 'error'
export type RavelActivity = 'idle' | 'thinking' | 'needs-clarification'

export interface RavelMessage {
  id: string
  author: 'user' | 'ravel' | 'system'
  body: string
  createdAt: number
  delivery: 'pending' | 'delivered' | 'failed'
  /**
   * Answers offered with a question, so a closed choice is one click instead
   * of a sentence the operator has to phrase. Absent on everything else, and
   * never a substitute for typing: the reply box stays open.
   */
  options?: string[]
}

/** A clarification may offer at most this many choices before it is a form. */
export const MAX_CLARIFICATION_OPTIONS = 5
export const MAX_CLARIFICATION_OPTION_CHARS = 80

export interface RavelMission {
  goal: string
  context: string[]
  constraints: string[]
  acceptanceCriteria: string[]
  assumptions: string[]
}

export type RavelBriefPhase = 'before-implementation' | 'implementation' | 'after-implementation'

/**
 * The only phase vocabulary there is.
 *
 * The manager's schema instructions are generated from this list and every
 * proposal is validated against it, because the two used to disagree: the
 * prompt asked for "research" and the store rejected it, so a model that
 * followed our own documentation had its plan thrown out on save.
 */
export const RAVEL_BRIEF_PHASES: readonly RavelBriefPhase[] = [
  'before-implementation',
  'implementation',
  'after-implementation'
]

export interface RavelBrief {
  id: string
  title: string
  role: ChildRavelRole
  harness: HarnessId
  /** Model override for this brief's child; null uses the harness default. */
  model: string | null
  phase: RavelBriefPhase
  goal: string
  relevantContext: string[]
  constraints: string[]
  acceptanceCriteria: string[]
  doNotTouch: string[]
  expectedOutput: string
  escalationConditions: string[]
  dependsOn: string[]
  contextExceptionReason: string | null
}

export interface RavelPlan {
  revision: number
  createdAt: number
  sourceMessageIds: string[]
  mission: RavelMission
  /**
   * One or two lines the orchestrator writes for every child to share.
   *
   * Deliberately not the mission: this is the only cross-brief context an agent
   * receives, and it exists so a child knows roughly what it is part of without
   * learning what anyone else is doing. Hard-clipped so it cannot grow into the
   * mission by accident.
   */
  orientation: string
  briefs: RavelBrief[]
  approvedAt: number | null
  approvedRevision: number | null
}

export interface RavelDispatchRecord {
  briefId: string
  planRevision: number
  sessionId: string | null
  branch: string
  worktreePath: string
  /** `detached`: the operator detached a live child; its session was promoted to a standalone session and the ravel relinquished it. Terminal, publishes no report, satisfies no dependency. */
  status: 'starting' | 'active' | 'completed' | 'failed' | 'interrupted' | 'detached'
  startedAt: number
  /**
   * When the child's process exited. null while it is still live.
   *
   * Separate from `startedAt` because a dispatch's duration is a fact the insight
   * rules read; deriving it from "not live any more" would date every legacy record
   * to whenever it was next loaded.
   */
  endedAt: number | null
  /**
   * The base SHA the worktree branched from, captured before creation.
   *
   * Diffing against a moving `HEAD` would attribute other people's commits to this
   * child. null on records written before this field existed; the collector recovers
   * those best-effort and omits the dispatch rather than reporting a false "no diff".
   */
  baseCommit: string | null
  usage: RavelUsage
  /** Child's written report, clipped. null when it wrote none. */
  report: string | null
  /**
   * How many times this child asked the orchestrator for more context.
   *
   * A role that keeps asking was mis-tiered or under-briefed, so this is a
   * routing signal as much as a safety counter.
   */
  contextRequests: number
  /**
   * Result of the repo's own verify command, run in this child's worktree when
   * it finished. null when no command is configured or it never ran.
   */
  verification: DispatchVerification | null
  /**
   * Operator archived this terminal dispatch. Additive + optional (no store
   * migration): absent/false is a live record. Archived dispatches are filtered
   * out of the PUBLIC config projection (fleet/worker views) but retained in the
   * stored config, so insights and reattach still see the full history.
   */
  archived?: boolean
}

export interface DispatchVerification {
  ok: boolean
  /** Clipped tail of the command's output — enough to act on, not a transcript. */
  output: string
}

/** Character-derived estimate. Never a figure reported by a provider. */
export interface RavelUsage {
  inputTokens: number
  outputTokens: number
  /** null when no rate entry exists for the model — never 0, which reads as free. */
  costUsd: number | null
}

export const EMPTY_RAVEL_USAGE: RavelUsage = { inputTokens: 0, outputTokens: 0, costUsd: null }

export interface RavelConfig {
  id: string
  name: string
  repoId: string
  repoPath: string
  harness: HarnessId
  /** Model override for the Reigen manager; null uses the harness default. */
  model: string | null
  /** Legacy persisted field retained for compatibility; scheduling ignores it. */
  maxChildren: number
  allowRisky: boolean
  status: RavelStatus
  activity: RavelActivity
  managerSessionId: string | null
  messages: RavelMessage[]
  plan: RavelPlan | null
  dispatches: RavelDispatchRecord[]
  createdAt: number
  error: string | null
  usage: RavelUsage
}

export type PublicRavelConfig = RavelConfig

export interface RavelActionError {
  code: string
  message?: string
  field?: string
  briefId?: string
  dependencyId?: string
  currentRevision?: number | null
  requestedRevision?: number
}

export type RavelActionResult =
  | { ok: true; ravel: PublicRavelConfig }
  | { ok: false; error: RavelActionError }

export interface CreateRavelRequest {
  /** Legacy callers may send a name; Reigen is always canonicalized by the main process. */
  name?: string
  repoId: string
  repoPath: string
  harness: HarnessId
  model?: string
  initialInstruction?: string
  /** Legacy input retained for IPC compatibility; ignored by the adaptive scheduler. */
  maxChildren?: number
  allowRisky?: boolean
}

export type RavelLogLevel = 'info' | 'action' | 'warn' | 'error'

export interface RavelLogEntry {
  id: string
  ravelId: string
  ts: number
  level: RavelLogLevel
  event: string
  childSessionId?: string
  text: string
}

export interface UpdateRavelBriefAssignmentRequest {
  role?: ChildRavelRole
  harness?: HarnessId
  /** Explicit null clears the override and falls back to the harness default. */
  model?: string | null
}

export interface RavelConflictError {
  code: 'stale-revision'
  currentRevision: number | null
  requestedRevision: number
}

/**
 * A roundtable is not a role and not a fleet: it is two or three named models
 * talking to each other about one question, in turns, with nobody editing
 * anything.
 *
 * Ravel decomposes and delegates; a roundtable deliberates. The output is a
 * strategy the operator can act on — or hand straight to a Ravel as its opening
 * instruction, which is the only way the two shapes touch.
 */
export interface RoundtableSeat {
  id: string
  /** What the operator calls this seat, e.g. "Opus" or "The sceptic". */
  name: string
  harness: HarnessId
  /** null uses the harness default. */
  model: string | null
  /** One line: why this seat is at the table. Empty is allowed. */
  stance: string
}

export interface RoundtableTurn {
  id: string
  /** Seat that spoke, or null for the operator. */
  seatId: string | null
  body: string
  createdAt: number
  usage: RavelUsage
}

export type RoundtableStatus = 'idle' | 'running' | 'paused' | 'concluded' | 'error'

export interface RoundtableConfig {
  id: string
  name: string
  repoId: string
  repoPath: string
  /** The question put to the table, in the operator's own words. */
  topic: string
  seats: RoundtableSeat[]
  turns: RoundtableTurn[]
  /**
   * Hard stop on how many turns the table may take.
   *
   * Two models will agree with each other forever on your quota, so a
   * roundtable is bounded before it starts rather than watched while it runs.
   */
  maxTurns: number
  status: RoundtableStatus
  /** The strategy the table settled on. null until a seat concludes. */
  conclusion: string | null
  error: string | null
  usage: RavelUsage
  createdAt: number
}

export const MIN_ROUNDTABLE_SEATS = 2
export const MAX_ROUNDTABLE_SEATS = 3
export const MAX_ROUNDTABLE_TURNS = 24
export const DEFAULT_ROUNDTABLE_TURNS = 6
/** One contribution, clipped. A turn is an argument, not an essay. */
export const MAX_ROUNDTABLE_TURN_CHARS = 4_000
/** Marker a seat writes when it believes the table has settled. */
export const ROUNDTABLE_CONCLUSION_MARKER = 'CONCLUSION:'

export interface CreateRoundtableRequest {
  name: string
  repoId: string
  repoPath: string
  topic: string
  seats: Array<Omit<RoundtableSeat, 'id'>>
  maxTurns?: number
}

export type RoundtableActionResult =
  | { ok: true; roundtable: RoundtableConfig }
  | { ok: false; error: RavelActionError }
