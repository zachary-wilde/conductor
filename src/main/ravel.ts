/**
 * Ravel — a conversation-owned orchestration runtime for parallel coding sessions.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { availableParallelism } from 'node:os'
import { mkdirSync, readFileSync, unlinkSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import * as sessions from './sessions'
import type { SessionExitResult } from './sessions'
import * as git from './git'
import { detectHarnesses as detectHarnessesWithSettings, runHeadlessHarness } from './harness'
import { classifyHarnessFailure, nextFallbackHarness } from './harness-fallback'
import { runHook } from './hooks'
import type { InsightTrigger } from './insights/types'
import { store } from './store'
import {
  applyBriefAssignmentToPlan,
  approveCurrentPlan,
  buildRolePrompt,
  canResumeInterruptedBrief,
  canSpawnBrief,
  createPlanRevision,
  interruptLiveDispatchesForRestart,
  validateTranscriptContent,
  type TranscriptValidationResult,
  type ValidationError
} from './ravel-model'
import {
  buildManagerContext,
  parseToolCalls,
  stripAnsi,
  type FleetSnapshot,
  type ManagerContext,
  type ToolCall
} from './manager-turn'
import {
  MAX_CLARIFICATION_OPTIONS,
  MAX_CLARIFICATION_OPTION_CHARS,
  HARNESS_INFO,
  type CreateRavelRequest,
  type CreateSessionRequest,
  type HarnessAvailability,
  type HarnessId,
  type PublicRavelConfig,
  type RavelActionResult,
  type RavelBrief,
  type RavelConfig,
  type RavelDispatchRecord,
  type DispatchVerification,
  type RavelLogEntry,
  type RavelLogLevel,
  type RavelMessage,
  type RavelMission,
  type RavelPlan,
  type RavelUsage,
  EMPTY_RAVEL_USAGE,
  splitModel,
  type Session,
  type Settings,
  type UpdateRavelBriefAssignmentRequest
} from '@shared/types'
import { addUsage, defaultModelForRole, estimateCostUsd, estimateTokens } from '@shared/pricing'

export interface RavelContext {
  resolveWorktreeRoot: () => string
  emit: (channel: string, ...args: unknown[]) => void
  detectHarnesses: (settings: Settings) => Promise<HarnessAvailability[]>
}

let ctx: RavelContext = {
  resolveWorktreeRoot: () => '.',
  emit: () => {},
  detectHarnesses: detectHarnessesWithSettings
}

export function setRavelContext(c: RavelContext): void {
  ctx = c
}

/**
 * Injected so this module never imports the insight coordinator. Insights observe
 * orchestration; orchestration must not depend on them, and a default no-op keeps
 * every test and the smoke harness free of the whole subsystem.
 *
 * The call is wrapped because a notifier is foreign code on a persistence path: an
 * observer that throws must never take a ravel down with it.
 */
let insightNotifier: (trigger: InsightTrigger, ravelId: string) => void = () => {}

export function setInsightNotifier(fn: (trigger: InsightTrigger, ravelId: string) => void): void {
  insightNotifier = fn
}

function noteInsight(trigger: InsightTrigger, ravelId: string): void {
  try {
    insightNotifier(trigger, ravelId)
  } catch (e) {
    console.error(`[conductor] insight notifier failed for ${trigger}:`, e)
  }
}

/**
 * Every process-touching dependency the runtime uses. Tests replace parts of
 * it with fakes so orchestration can be exercised without spawning a harness,
 * creating a worktree, or writing the real store.
 */
export interface RavelRuntimeServices {
  createSession: typeof sessions.createSession
  getSession: typeof sessions.getSession
  listSessions: typeof sessions.listSessions
  writeToSession: typeof sessions.writeToSession
  killSession: typeof sessions.killSession
  promoteToStandalone: typeof sessions.promoteToStandalone
  runHeadlessHarness: typeof runHeadlessHarness
  createWorktree: typeof git.createWorktree
  removeWorktree: typeof git.removeWorktree
  currentBranch: typeof git.currentBranch
  resolveCommit: typeof git.resolveCommit
  worktreePathFor: typeof git.worktreePathFor
  trackWorktree: typeof store.trackWorktree
  untrackWorktree: typeof store.untrackWorktree
  getSettings: typeof store.getSettings
  getRavel: typeof store.getRavel
  getRavelById: typeof store.getRavelById
  addRavel: typeof store.addRavel
  replaceRavel: typeof store.replaceRavel
  updateRavel: typeof store.updateRavel
  removeRavel: typeof store.removeRavel
  /**
   * Runs the repo's verify command in a finished child's worktree. Shares
   * `runHook`'s runner deliberately: bash-or-cmd, timeout and output capture
   * are already solved there, and a second runner would drift from it.
   */
  runVerify: typeof runHook
}

const productionServices: RavelRuntimeServices = {
  createSession: (req, settings) => sessions.createSession(req, settings),
  getSession: (id) => sessions.getSession(id),
  listSessions: () => sessions.listSessions(),
  writeToSession: (id, data) => sessions.writeToSession(id, data),
  killSession: (id) => sessions.killSession(id),
  promoteToStandalone: (id) => sessions.promoteToStandalone(id),
  runHeadlessHarness: (id, settings, prompt, opts) => runHeadlessHarness(id, settings, prompt, opts),
  createWorktree: (repoPath, branch, opts) => git.createWorktree(repoPath, branch, opts),
  removeWorktree: (repoPath, target, opts) => git.removeWorktree(repoPath, target, opts),
  currentBranch: (repoPath) => git.currentBranch(repoPath),
  resolveCommit: (repoPath, revision) => git.resolveCommit(repoPath, revision),
  worktreePathFor: (repoPath, branch, root) => git.worktreePathFor(repoPath, branch, root),
  trackWorktree: (path, meta) => store.trackWorktree(path, meta),
  untrackWorktree: (path) => store.untrackWorktree(path),
  getSettings: () => store.getSettings(),
  getRavel: () => store.getRavel(),
  getRavelById: (id) => store.getRavelById(id),
  addRavel: (cfg) => store.addRavel(cfg),
  replaceRavel: (id, cfg) => store.replaceRavel(id, cfg),
  updateRavel: (id, patch) => store.updateRavel(id, patch),
  removeRavel: (id) => store.removeRavel(id),
  runVerify: (script, hookCtx, timeoutMs) => runHook(script, hookCtx, timeoutMs)
}

let svc: RavelRuntimeServices = productionServices

/** Test seam. Pass null to restore the production dependencies. */
export function setRavelRuntimeServicesForTest(overrides: Partial<RavelRuntimeServices> | null): void {
  svc = overrides === null ? productionServices : { ...productionServices, ...overrides }
}

interface RavelRuntime {
  cfg: RavelConfig
  queue: Promise<unknown>
  /** Briefs accepted after approval but waiting for internal capacity. */
  queuedBriefs: string[]
  invalidPlanAttempts: Map<string, number>
  /** Results of the tool batch the current turn just ran, fed back to the next turn. */
  turnResults: TurnResult[]
  turnAbort: AbortController | undefined
  /** Per-child worktree watchers for the context-request channel, keyed by session id. */
  requestWatchers: Map<string, FSWatcher>
  /**
   * Briefs whose verify command is still running.
   *
   * A child is persisted as `completed` the moment it exits, but its verdict
   * arrives later. Two children exiting together would otherwise let the first
   * one's manager turn see the second as finished and call `complete` before
   * anything checked it — the exact guarantee the feature exists to make.
   */
  verifying: Set<string>
  /** Cancels a verify command that is still running when the Ravel stops. */
  verifyAbort: AbortController | undefined
  closing: boolean
}

interface TurnResult {
  ok: boolean
  text: string
}


type PlanProposalPayload = {
  sourceMessageIds: string[]
  orientation: string
  mission: RavelMission
  briefs: RavelBrief[]
}

const runtimes = new Map<string, RavelRuntime>()
const logs = new Map<string, RavelLogEntry[]>()
const MAX_CHILDREN = new Set<number>([2, 4, 8, 16])
const DEFAULT_MAX_CHILDREN = 8
let internalChildCapacity = Math.max(2, Math.min(8, availableParallelism()))

/**
 * Test seam: pins the adaptive capacity so queue/drain coverage is host-
 * independent. Production derives it from available parallelism; pass null to
 * restore that derivation. Scheduling reads `internalChildCapacity`, never the
 * host value directly.
 */
export function setInternalChildCapacityForTest(value: number | null): void {
  internalChildCapacity = value === null ? Math.max(2, Math.min(8, availableParallelism())) : value
}
const MAX_LOG_ENTRIES = 500
const MAX_CONVERSATION_MESSAGES = 200
const FULL_CONTEXT_CHARS = 200_000
/**
 * One user action or child event buys at most this many manager invocations.
 * A turn only re-runs when it has something to fix or a status it asked for,
 * so the common case costs exactly one.
 */
const MAX_TURNS_PER_EVENT = 3
/**
 * How many times one child may ask for more context before the channel closes.
 *
 * Each request costs a manager turn, and a confused agent will loop. Refusing
 * past the cap also keeps the boundary honest: a brief that needs a fourth
 * answer was mis-scoped, and that should surface as a planning problem rather
 * than quietly reassembling the whole mission one reply at a time.
 */
const MAX_CONTEXT_REQUESTS = 3
/** Directory a child writes into to reach Conductor. */
const CHILD_CHANNEL_DIR = '.conductor'
const CHILD_REQUEST_FILE = 'request.md'
const MAX_REQUEST_CHARS = 2_000
/** Tool names after which the manager is waiting on the user, not on itself. */
const AWAIT_USER_TOOLS: Record<string, true> = { reply: true, ask_clarification: true, complete: true }
const LIVE_DISPATCH_STATUSES: Record<RavelDispatchRecord['status'], boolean> = {
  starting: true,
  active: true,
  completed: false,
  failed: false,
  interrupted: false,
  detached: false
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'brief'
  )
}

function short(id: string | null | undefined): string {
  return id ? id.slice(0, 8) : '?'
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function cloneJson<T>(value: T): T {
  return structuredClone(value)
}

/** Collapses a harness turn's output to one loggable line. */
function turnOutputSnippet(raw: string): string {
  const flat = stripAnsi(raw).trim().replace(/\s+/g, ' ')
  return flat.length <= 400 ? flat : `${flat.slice(0, 399)}…`
}


function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function normalizeBrief(value: unknown): RavelBrief {
  const brief = typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
  return {
    id: typeof brief.id === 'string' ? brief.id : '',
    title: typeof brief.title === 'string' ? brief.title : '',
    role: typeof brief.role === 'string' ? brief.role as RavelBrief['role'] : 'minor-task',
    harness: typeof brief.harness === 'string' ? brief.harness as HarnessId : 'claude',
    model: typeof brief.model === 'string' && brief.model.trim().length > 0 ? brief.model.trim() : null,
    phase: typeof brief.phase === 'string' ? brief.phase as RavelBrief['phase'] : 'implementation',
    goal: typeof brief.goal === 'string' ? brief.goal : '',
    relevantContext: asStringArray(brief.relevantContext),
    constraints: asStringArray(brief.constraints),
    acceptanceCriteria: asStringArray(brief.acceptanceCriteria),
    doNotTouch: asStringArray(brief.doNotTouch),
    expectedOutput: typeof brief.expectedOutput === 'string' ? brief.expectedOutput : '',
    escalationConditions: asStringArray(brief.escalationConditions),
    dependsOn: asStringArray(brief.dependsOn),
    contextExceptionReason:
      typeof brief.contextExceptionReason === 'string' ? brief.contextExceptionReason : null
  }
}

function trimMessages(messages: RavelMessage[], plan: RavelPlan | null): RavelMessage[] {
  const next = messages.slice()
  const sourceIds = new Set(plan?.sourceMessageIds ?? [])
  while (next.length > MAX_CONVERSATION_MESSAGES) {
    const removableIndex = next.findIndex(
      (message) =>
        !sourceIds.has(message.id) &&
        !(message.author === 'system' && message.body.startsWith('Migrated from legacy'))
    )
    next.splice(removableIndex === -1 ? 0 : removableIndex, 1)
  }
  return next
}

function emitChanged(cfg: RavelConfig): void {
  ctx.emit('ravel:update', toPublicRavelConfig(cfg))
}

function emitChildrenChanged(ravelId: string): void {
  ctx.emit('ravel:children', ravelId)
}

export function toPublicRavelConfig(cfg: RavelConfig): PublicRavelConfig {
  const cloned = cloneJson(cfg)
  // Archived dispatches stay in the stored config (insights/reattach see them)
  // but are hidden from every public projection — the fleet/worker views.
  return {
    ...cloned,
    name: 'Reigen',
    dispatches: cloned.dispatches.filter((d) => !d.archived)
  }
}

function appendLog(
  ravelId: string,
  level: RavelLogLevel,
  event: string,
  text: string,
  childSessionId?: string
): RavelLogEntry {
  const entry: RavelLogEntry = {
    id: randomUUID(),
    ravelId,
    ts: Date.now(),
    level,
    event,
    childSessionId,
    text
  }
  const arr = logs.get(ravelId) ?? []
  arr.push(entry)
  if (arr.length > MAX_LOG_ENTRIES) arr.splice(0, arr.length - MAX_LOG_ENTRIES)
  logs.set(ravelId, arr)
  ctx.emit('ravel:log', entry)
  return entry
}

export function getLog(ravelId: string): RavelLogEntry[] {
  return cloneJson(logs.get(ravelId) ?? [])
}

function ensureRuntime(cfg: RavelConfig): RavelRuntime {
  const existing = runtimes.get(cfg.id)
  if (existing) {
    existing.cfg = cloneJson(cfg)
    return existing
  }
  const rt: RavelRuntime = {
    cfg: cloneJson(cfg),
    queue: Promise.resolve(),
    queuedBriefs: [],
    invalidPlanAttempts: new Map(),
    turnResults: [],
    turnAbort: undefined,
    requestWatchers: new Map(),
    verifying: new Set(),
    verifyAbort: undefined,
    closing: false
  }
  runtimes.set(cfg.id, rt)
  return rt
}

function runtimeFor(id: string): RavelRuntime | undefined {
  const persisted = svc.getRavelById(id)
  return persisted ? ensureRuntime(persisted) : undefined
}

function saveConfig(rt: RavelRuntime, next: RavelConfig): RavelConfig {
  const previousActivity = rt.cfg.activity
  const saved = svc.replaceRavel(next.id, next)
  if (!saved) throw new Error(`ravel not found: ${next.id}`)
  rt.cfg = cloneJson(saved)
  emitChanged(saved)
  if (saved.activity !== previousActivity) noteInsight('activity-changed', saved.id)
  return saved
}

function updateConfig(rt: RavelRuntime, patch: Partial<RavelConfig>): RavelConfig {
  const previousActivity = rt.cfg.activity
  const saved = svc.updateRavel(rt.cfg.id, patch)
  if (!saved) throw new Error(`ravel not found: ${rt.cfg.id}`)
  rt.cfg = cloneJson(saved)
  emitChanged(saved)
  if (saved.activity !== previousActivity) noteInsight('activity-changed', saved.id)
  return saved
}

function enqueue<T>(rt: RavelRuntime, work: () => Promise<T> | T): Promise<T> {
  const run = rt.queue.then(work, work)
  rt.queue = run.catch(() => undefined)
  return run
}

/**
 * Tool results no longer travel back through a pty; they are collected for the
 * next invocation inside the same event, and dropped if the turn ends here.
 */
function toolResult(rt: RavelRuntime, obj: unknown): void {
  const ok = typeof obj === 'object' && obj !== null && 'ok' in obj && obj.ok === true
  rt.turnResults.push({ ok, text: JSON.stringify(obj) })
}

/**
 * What a turn is for. The directive is the only per-event text in the prompt:
 * everything else the manager sees is the bounded snapshot from
 * `buildManagerContext`, so a directive must carry its own ids.
 */
function userDirective(message: RavelMessage, cfg: RavelConfig): string {
  return [
    'EVENT: the user sent a message.',
    `sourceMessageId: ${message.id}`,
    `currentPlanRevision: ${cfg.plan?.revision ?? 'null'}`,
    'Reply, ask for clarification, or propose a plan citing that source id.',
    '',
    message.body
  ].join('\n')
}

function planChangesDirective(message: RavelMessage, planRevision: number): string {
  return [
    'EVENT: the user requested plan changes.',
    `sourceMessageId: ${message.id}`,
    `previousPlanRevision: ${planRevision}`,
    'The previous approval has been cleared. Propose a new revision citing that source id.',
    '',
    message.body
  ].join('\n')
}

function retryDirective(message: RavelMessage): string {
  return [
    'EVENT: plan compilation is being retried.',
    `sourceMessageId: ${message.id}`,
    'Return propose_plan with the structural errors from the previous attempt corrected.',
    '',
    message.body
  ].join('\n')
}

function approvedPlanDirective(plan: RavelPlan): string {
  return [
    `EVENT: the user approved plan revision ${plan.revision}.`,
    'Spawn every brief that has no unfinished dependency now, one spawn_child call each.',
    `ready briefs: ${plan.briefs.filter((brief) => brief.dependsOn.length === 0).map((brief) => brief.id).join(', ') || '(none)'}`
  ].join('\n')
}

function childExitDirective(
  briefId: string,
  completed: boolean,
  plan: RavelPlan | null,
  report: string | null,
  verification: DispatchVerification | null
): string {
  const lines = [
    `EVENT: child for brief ${briefId} ${completed ? 'completed' : 'failed'}.`,
    plan === null
      ? 'No plan is current.'
      : 'Spawn any brief whose dependencies are now satisfied, or call complete when every brief is done.'
  ]
  // The repo's own verdict outranks the child's account of itself, so it is
  // stated before the report the child chose to publish.
  if (verification !== null) {
    lines.push(
      '',
      `VERIFY COMMAND ${verification.ok ? 'PASSED' : 'FAILED'} in that child's worktree:`,
      verification.output
    )
  }
  if (report !== null) {
    lines.push('', `REPORT FROM ${briefId} (first 800 chars):`, report.slice(0, 800))
  }
  return lines.join('\n')
}

/**
 * Deliberately does not restate the mission. The manager already holds it; the
 * point of the exchange is that the manager decides which fragment this role is
 * allowed to have, not that the boundary dissolves on request.
 */
function contextRequestDirective(briefId: string, childId: string, question: string): string {
  return [
    `EVENT: the child working on brief ${briefId} is asking for more context.`,
    `childId: ${childId}`,
    '',
    'QUESTION:',
    question,
    '',
    "Answer with message_child to that childId. Release only what this brief's",
    "role needs to proceed — never the mission, another brief, or the user's",
    'words. If the answer is genuinely outside its remit, say so plainly.'
  ].join('\n')
}

/**
 * The operator's words reach the orchestrator, never the child.
 *
 * Handing a note straight to a role would put whatever context the operator
 * happened to phrase it with inside a scope that is supposed to know only its
 * own brief. The manager decides what to pass on, exactly as it does for a
 * child's own request for context.
 */
function steerDirective(briefId: string, childId: string, note: string): string {
  return [
    `EVENT: the operator wants the child working on brief ${briefId} redirected.`,
    `childId: ${childId}`,
    '',
    'NOTE FROM THE OPERATOR:',
    note,
    '',
    'Send that child what its role needs with message_child to that childId.',
    'Release only what this brief requires — never the mission, another brief,',
    'or wording that carries more than this role should know. If the note asks',
    'for something outside this brief, say so with reply instead of forwarding it.'
  ].join('\n')
}

function usageFor(model: string | null, inputChars: number, outputChars: number): RavelUsage {
  const inputTokens = estimateTokens(inputChars)
  const outputTokens = estimateTokens(outputChars)
  const key = model === null ? null : splitModel(model).model
  return { inputTokens, outputTokens, costUsd: estimateCostUsd(key, inputTokens, outputTokens) }
}

/** Crossing the ceiling stops the ravel outright: no further turns, no spawns. */
function budgetExceeded(cfg: RavelConfig, settings: Settings): boolean {
  const ceiling = settings.tokenCeilingPerRavel
  if (ceiling <= 0) return false
  return cfg.usage.inputTokens + cfg.usage.outputTokens >= ceiling
}

/**
 * Stops the ravel outright: the running turn is aborted, no further turn or
 * spawn is admitted, and every live child is killed.
 *
 * Killing children is what makes the ceiling a budget rather than a speed
 * bump. Their dispatches are marked `interrupted`, not `failed`, so the
 * worktrees survive and the operator can resume each brief after raising the
 * ceiling — the work is suspended, never discarded.
 */
function pauseForBudget(rt: RavelRuntime, ceiling: number): void {
  const spent = rt.cfg.usage.inputTokens + rt.cfg.usage.outputTokens
  rt.cfg = { ...rt.cfg, status: 'paused', activity: 'idle' }
  rt.turnAbort?.abort()
  rt.verifyAbort?.abort()
  const stopped = stopLiveChildren(rt)
  updateConfig(rt, {
    status: 'paused',
    activity: 'idle',
    error: `Paused at the token ceiling: ~${spent} of ${ceiling} estimated tokens used. Raise the ceiling in Settings, then resume.`
  })
  appendLog(
    rt.cfg.id,
    'warn',
    'budget',
    `token ceiling reached: ~${spent}/${ceiling} (est.)${stopped === 0 ? '' : ` · stopped ${stopped} live child${stopped === 1 ? '' : 'ren'}`}`
  )
}

/** Returns how many were stopped, for the operator-facing log line. */
function stopLiveChildren(rt: RavelRuntime): number {
  const live = rt.cfg.dispatches.filter((item) => LIVE_DISPATCH_STATUSES[item.status])
  if (live.length === 0) return 0
  for (const dispatch of live) {
    if (!dispatch.sessionId) continue
    stopWatchingChildRequests(rt, dispatch.sessionId)
    svc.killSession(dispatch.sessionId)
  }
  // Marked after the kill so the exit event finds a non-live dispatch and
  // leaves this status alone; a resumable brief must not become 'failed'.
  const dispatches = rt.cfg.dispatches.map((item) =>
    LIVE_DISPATCH_STATUSES[item.status] ? { ...item, status: 'interrupted' as const } : item
  )
  saveConfig(rt, { ...rt.cfg, dispatches })
  emitChildrenChanged(rt.cfg.id)
  return live.length
}

function resumeDirective(cfg: RavelConfig): string {
  return [
    'EVENT: the user resumed this Ravel.',
    cfg.plan === null
      ? 'Nothing is planned yet; reply or ask what to work on.'
      : 'Pick up the approved plan: spawn ready briefs, or report status with reply.'
  ].join('\n')
}

function fleetSnapshot(ravelId: string): FleetSnapshot {
  const now = Date.now()
  return {
    children: svc
      .listSessions()
      .filter((session) => session.kind === 'ravel-child' && session.ravelId === ravelId)
      .map((session) => ({
        sessionId: session.id,
        briefId: session.briefId,
        role: session.ravelRole ?? 'unknown',
        status: session.status,
        ageSeconds: Math.floor((now - session.lastActivityAt) / 1000)
      }))
  }
}

/**
 * Run one event to completion: build a bounded prompt, invoke the harness once
 * non-interactively, execute whatever tool calls came back, and stop.
 *
 * A second invocation only happens when the manager left work unresolved in the
 * same event — a failed call to correct, or a get_status whose answer it has not
 * seen yet — which is what keeps an idle fleet free.
 *
 * Must be called from inside `enqueue`: tool handlers mutate the runtime and
 * must not interleave with another event.
 */
async function runManagerTurns(rt: RavelRuntime, settings: Settings, directive: string): Promise<void> {
  let results: TurnResult[] = []
  let current = directive
  // A brief assigned to a harness that is not installed fails plan validation,
  // so the manager has to be told what it may choose from.
  const availability = await harnessAvailabilityRecord(settings)
  const availableHarnesses = (Object.keys(availability) as HarnessId[]).filter((id) => availability[id].available)

  for (let turn = 1; turn <= MAX_TURNS_PER_EVENT; turn += 1) {
    if (rt.closing || rt.cfg.status === 'paused') return
    if (budgetExceeded(rt.cfg, settings)) {
      pauseForBudget(rt, settings.tokenCeilingPerRavel)
      return
    }

    let context: ManagerContext
    try {
      context = buildManagerContext({
        ravel: rt.cfg,
        fleet: fleetSnapshot(rt.cfg.id),
        directive: current,
        availableHarnesses,
        toolResults: results.map((result) => result.text)
      })
    } catch (e) {
      failTurn(rt, `manager context exceeded its budget: ${msg(e)}`)
      return
    }

    const abort = new AbortController()
    rt.turnAbort = abort
    let raw: string
    try {
      raw = await runManagerTurnWithFallback(rt, settings, context.prompt, abort.signal, availability)
    } catch (e) {
      failTurn(rt, msg(e))
      return
    } finally {
      rt.turnAbort = undefined
    }
    if (rt.closing) return

    const calls = parseToolCalls(raw)
    const turnUsage = usageFor(rt.cfg.model, context.promptChars, raw.length)
    updateConfig(rt, { usage: addUsage(rt.cfg.usage, turnUsage) })
    appendLog(
      rt.cfg.id,
      'info',
      'turn',
      `turn ${turn}/${MAX_TURNS_PER_EVENT} · ${context.promptChars} prompt chars · ~${turnUsage.inputTokens} in / ~${
        turnUsage.outputTokens
      } out tok (est.) · ${calls.length} call${calls.length === 1 ? '' : 's'}${
        calls.length === 0 ? '' : `: ${calls.map((call) => String(call.tool ?? '?')).join(', ')}`
      }`
    )
    if (calls.length === 0) {
      appendLog(rt.cfg.id, 'warn', 'turn-empty', `no conductor-tool block in output: ${turnOutputSnippet(raw)}`)
      if (rt.cfg.activity === 'thinking') updateConfig(rt, { activity: 'idle' })
      return
    }

    rt.turnResults = []
    for (const call of calls) {
      if (rt.closing) return
      await handleToolCall(rt, call)
    }
    results = rt.turnResults
    rt.turnResults = []

    const awaitsUser = calls.some((call) => AWAIT_USER_TOOLS[String(call.tool)] === true)
    const unresolved = results.some((result) => !result.ok) || calls.some((call) => call.tool === 'get_status')
    if (awaitsUser || !unresolved) break
    current = `EVENT: your previous ${calls.length} call${
      calls.length === 1 ? '' : 's'
    } ran; the results are below. Fix what failed or act on what you asked for, then stop.`
  }

  if (rt.cfg.activity === 'thinking') updateConfig(rt, { activity: 'idle' })
}

/**
 * A turn that never produced tool calls leaves the Ravel idle with a visible
 * reason. Closing and pausing cancel the in-flight harness on purpose, so
 * neither is reported as a failure.
 */
function failTurn(rt: RavelRuntime, reason: string): void {
  if (rt.closing || rt.cfg.status === 'paused') return
  updateConfig(rt, { activity: 'idle', error: reason })
  appendLog(rt.cfg.id, 'error', 'turn', `manager turn failed: ${reason}`)
}

/**
 * Run one manager turn, re-pointing to the next installed vendor when the
 * current harness runs DRY (quota / rate limit / auth / uninstalled CLI) instead
 * of failing the turn. A genuine task failure or a plain timeout is rethrown
 * unchanged - retrying those on another vendor would just burn it too. The
 * re-point is STICKY (it updates `rt.cfg.harness`, so later turns use the new
 * vendor) and clears the model so the new vendor uses its own default. Bounded
 * by the fallback list: each installed vendor is tried at most once.
 */
async function runManagerTurnWithFallback(
  rt: RavelRuntime,
  settings: Settings,
  prompt: string,
  signal: AbortSignal,
  availability: Record<HarnessId, HarnessAvailability>
): Promise<string> {
  const available = new Set<HarnessId>(
    (Object.keys(availability) as HarnessId[]).filter((id) => availability[id].available)
  )
  const order = settings.harnessFallback ?? []
  const tried = new Set<HarnessId>()
  for (;;) {
    tried.add(rt.cfg.harness)
    try {
      return await svc.runHeadlessHarness(rt.cfg.harness, settings, prompt, {
        model: rt.cfg.model,
        cwd: rt.cfg.repoPath,
        signal
      })
    } catch (e) {
      const reason = msg(e)
      if (classifyHarnessFailure(reason) !== 'dry') throw e
      const next = nextFallbackHarness({ current: rt.cfg.harness, order, available, tried })
      if (!next) throw e
      appendLog(
        rt.cfg.id,
        'warn',
        'fallback',
        `manager harness ${HARNESS_INFO[rt.cfg.harness].label} ran dry (${reason}); re-pointing to ${HARNESS_INFO[next].label}`
      )
      updateConfig(rt, { harness: next, model: null })
    }
  }
}

async function handleToolCall(rt: RavelRuntime, call: ToolCall): Promise<void> {
  if (rt.closing) {
    toolResult(rt, { ok: false, error: ravelClosingError() })
    return
  }
  switch (call.tool) {
    case 'reply':
      return toolReply(rt, call)
    case 'ask_clarification':
      return toolAskClarification(rt, call)
    case 'propose_plan':
      return toolProposePlan(rt, call)
    case 'spawn_child':
      return toolSpawnChild(rt, call)
    case 'message_child':
      return toolMessageChild(rt, call)
    case 'get_status':
      return toolGetStatus(rt)
    case 'log':
      appendLog(rt.cfg.id, logLevel(call.level), 'log', String(call.text ?? ''))
      toolResult(rt, { ok: true })
      return
    case 'complete':
      return toolComplete(rt, call)
    default:
      toolResult(rt, { ok: false, error: { code: 'unknown-tool', message: `unknown tool: ${String(call.tool)}` } })
  }
}

function logLevel(level: unknown): RavelLogLevel {
  return level === 'action' || level === 'warn' || level === 'error' ? level : 'info'
}

function toolReply(rt: RavelRuntime, call: Record<string, unknown>): void {
  const validation = validateTranscriptContent(String(call.body ?? ''))
  if (!validation.ok) {
    toolResult(rt, { ok: false, error: validation.error })
    return
  }
  const body = validation.body
  const next: RavelConfig = {
    ...rt.cfg,
    activity: 'idle',
    messages: trimMessages([
      ...rt.cfg.messages,
      { id: randomUUID(), author: 'ravel', body, createdAt: Date.now(), delivery: 'delivered' }
    ], rt.cfg.plan)
  }
  saveConfig(rt, next)
  appendLog(rt.cfg.id, 'info', 'reply', `Ravel replied (${body.length} chars)`)
  toolResult(rt, { ok: true })
}

function hasApprovedPlan(cfg: RavelConfig): boolean {
  return cfg.plan !== null && cfg.plan.approvedAt !== null && cfg.plan.approvedRevision === cfg.plan.revision
}

function toolAskClarification(rt: RavelRuntime, call: Record<string, unknown>): void {
  if (hasApprovedPlan(rt.cfg)) {
    toolResult(rt, {
      ok: false,
      error: { code: 'clarification-not-allowed', message: 'ask_clarification is only allowed before plan approval.' }
    })
    return
  }
  const validation = validateTranscriptContent(String(call.question ?? ''))
  if (!validation.ok) {
    toolResult(rt, { ok: false, error: validation.error })
    return
  }
  const question = validation.body
  // A closed question is answered with a click; anything the manager cannot
  // enumerate stays a typed answer. Over-long or surplus choices are clipped
  // rather than refused — the question is still worth asking without them.
  const options = Array.isArray(call.options)
    ? call.options
        .filter((option): option is string => typeof option === 'string')
        .map((option) => option.trim().slice(0, MAX_CLARIFICATION_OPTION_CHARS))
        .filter((option) => option.length > 0)
        .slice(0, MAX_CLARIFICATION_OPTIONS)
    : []
  const next: RavelConfig = {
    ...rt.cfg,
    activity: 'needs-clarification',
    messages: trimMessages([
      ...rt.cfg.messages,
      {
        id: randomUUID(),
        author: 'ravel',
        body: question,
        createdAt: Date.now(),
        delivery: 'delivered',
        ...(options.length > 0 ? { options } : {})
      }
    ], rt.cfg.plan)
  }
  saveConfig(rt, next)
  appendLog(rt.cfg.id, 'info', 'clarification', question.slice(0, 160))
  toolResult(rt, { ok: true })
}

async function toolProposePlan(rt: RavelRuntime, call: Record<string, unknown>): Promise<void> {
  const settings = svc.getSettings()
  const proposal = normalizeProposal(call)
  const sourceErrors = validateSourceIds(rt.cfg, proposal.sourceMessageIds)
  const harnessAvailability = await harnessAvailabilityRecord(settings)
  const result = createPlanRevision({
    proposal,
    previousPlan: rt.cfg.plan,
    now: Date.now(),
    fullContextChars: FULL_CONTEXT_CHARS,
    harnessAvailability
  })
  const errors = result.ok ? sourceErrors : [...sourceErrors, ...result.errors]
  if (errors.length > 0) {
    const key = invalidSourceKey(proposal.sourceMessageIds)
    const attempts = (rt.invalidPlanAttempts.get(key) ?? 0) + 1
    rt.invalidPlanAttempts.set(key, attempts)
    if (attempts >= 3) {
      updateConfig(rt, {
        status: 'error',
        activity: 'idle',
        error: 'Ravel produced three invalid plan proposals for the same source messages.'
      })
    }
    appendLog(rt.cfg.id, 'warn', 'plan-invalid', `invalid proposal attempt ${attempts}: ${errors.map((e) => e.code).join(', ')}`)
    toolResult(rt, { ok: false, errors, attempts })
    return
  }
  if (!result.ok) return
  const transcriptBody = validateTranscriptContent(
    `Proposed plan revision ${result.plan.revision} with ${result.plan.briefs.length} brief${result.plan.briefs.length === 1 ? '' : 's'}.`
  )
  if (!transcriptBody.ok) {
    toolResult(rt, { ok: false, error: transcriptBody.error })
    return
  }
  const transcript: RavelMessage = {
    id: randomUUID(),
    author: 'ravel',
    body: transcriptBody.body,
    createdAt: Date.now(),
    delivery: 'delivered'
  }
  const next: RavelConfig = {
    ...rt.cfg,
    status: 'awaiting-approval',
    activity: 'idle',
    plan: result.plan,
    messages: trimMessages([...rt.cfg.messages, transcript], result.plan),
    error: null
  }
  saveConfig(rt, next)
  appendLog(rt.cfg.id, 'action', 'plan', `proposed plan revision ${result.plan.revision}`)
  toolResult(rt, { ok: true, revision: result.plan.revision })
}

function normalizeProposal(call: Record<string, unknown>): PlanProposalPayload {
  const missionValue =
    typeof call.mission === 'object' && call.mission !== null && !Array.isArray(call.mission)
      ? call.mission as Record<string, unknown>
      : {}
  const briefs = Array.isArray(call.briefs) ? call.briefs.map(normalizeBrief) : []
  return {
    sourceMessageIds: asStringArray(call.sourceMessageIds),
    orientation: typeof call.orientation === 'string' ? call.orientation : '',
    mission: {
      goal: typeof missionValue.goal === 'string' ? missionValue.goal : '',
      context: asStringArray(missionValue.context),
      constraints: asStringArray(missionValue.constraints),
      acceptanceCriteria: asStringArray(missionValue.acceptanceCriteria),
      assumptions: asStringArray(missionValue.assumptions)
    },
    briefs
  }
}

function validateSourceIds(cfg: RavelConfig, sourceMessageIds: string[]): ValidationError[] {
  const known = new Set(cfg.messages.map((message) => message.id))
  return sourceMessageIds
    .filter((sourceId) => !known.has(sourceId))
    .map((sourceId) => ({
      code: 'source-message-id-unknown',
      message: 'Plan sourceMessageIds must refer to persisted conversation messages.',
      field: 'sourceMessageIds',
      dependencyId: sourceId
    }))
}

function invalidSourceKey(sourceMessageIds: string[]): string {
  return sourceMessageIds.length > 0 ? sourceMessageIds.slice().sort().join('\u0000') : '<missing-source>'
}

async function removeUntouchedWorktree(rt: RavelRuntime, worktreePath: string, branch: string): Promise<void> {
  try {
    await svc.removeWorktree(rt.cfg.repoPath, worktreePath, { force: true, deleteBranch: branch })
    svc.untrackWorktree(worktreePath)
    appendLog(rt.cfg.id, 'info', 'spawn-cleanup', `removed untouched worktree ${worktreePath}`)
  } catch (e) {
    appendLog(rt.cfg.id, 'warn', 'spawn-cleanup', `could not remove untouched worktree ${worktreePath}: ${msg(e)}`)
  }
}

function liveChildCount(rt: RavelRuntime): number {
  let count = 0
  for (const dispatch of rt.cfg.dispatches) {
    if (LIVE_DISPATCH_STATUSES[dispatch.status]) count += 1
  }
  return count
}

function spawnBlocker(rt: RavelRuntime): { code: string; message: string } | null {
  if (rt.closing) return { code: 'ravel-closing', message: 'Ravel is closing.' }
  if (rt.cfg.status !== 'running') {
    return { code: 'ravel-not-running', message: 'Ravel must be running before spawning briefs.' }
  }
  return null
}

async function toolSpawnChild(rt: RavelRuntime, call: Record<string, unknown>): Promise<void> {
  const keys = Object.keys(call).filter((key) => key !== 'tool' && key !== 'briefId')
  if (keys.length > 0) {
    toolResult(rt, { ok: false, error: { code: 'spawn-brief-id-only', message: 'spawn_child accepts only briefId.' } })
    return
  }
  const blocked = spawnBlocker(rt)
  if (blocked) {
    toolResult(rt, { ok: false, error: blocked })
    return
  }
  const plan = rt.cfg.plan
  if (!plan) {
    toolResult(rt, { ok: false, error: { code: 'plan-required', message: 'A plan is required before spawning.' } })
    return
  }
  const briefId = String(call.briefId ?? '').trim()
  if (rt.queuedBriefs.includes(briefId)) {
    toolResult(rt, { ok: true, queued: true, briefId, message: 'Brief is already queued for internal capacity.' })
    return
  }
  const harnessAvailability = await harnessAvailabilityRecord(svc.getSettings())
  const afterHarnessBlocked = spawnBlocker(rt)
  if (afterHarnessBlocked) {
    toolResult(rt, { ok: false, error: afterHarnessBlocked })
    return
  }
  const eligibility = canSpawnBrief(rt.cfg, {
    briefId,
    planRevision: plan.revision,
    fullContextChars: FULL_CONTEXT_CHARS,
    harnessAvailability
  })
  if (!eligibility.ok) {
    toolResult(rt, { ok: false, error: eligibility.error })
    return
  }
  if (liveChildCount(rt) >= internalChildCapacity) {
    rt.queuedBriefs.push(briefId)
    appendLog(rt.cfg.id, 'info', 'spawn-queued', `${briefId} queued; internal capacity is ${internalChildCapacity}`)
    toolResult(rt, { ok: true, queued: true, briefId, message: 'Brief queued until internal capacity is available.' })
    return
  }
  if (budgetExceeded(rt.cfg, svc.getSettings())) {
    pauseForBudget(rt, svc.getSettings().tokenCeilingPerRavel)
    toolResult(rt, { ok: false, error: { code: 'token-ceiling', message: 'token ceiling reached; ravel paused' } })
    return
  }
  const prompt = childPrompt(eligibility.brief, dependencyOutputs(rt.cfg, eligibility.brief), plan.orientation)
  const inputTokens = estimateTokens(prompt.length)
  const branch = `ravel/${slug(eligibility.brief.id)}-${randomBytes(3).toString('hex')}`
  const worktreePath = svc.worktreePathFor(rt.cfg.repoPath, branch, ctx.resolveWorktreeRoot())
  // Captured BEFORE anything is persisted and then used as the branch point, so a
  // commit landing on the base in between cannot be attributed to this child.
  //
  // A repo whose HEAD will not resolve cannot have a worktree branched off it
  // either, so this fails the spawn outright instead of recording a dispatch with
  // no measurable base. Swallowing the error here bought a dispatch that looked
  // fine and silently reported no changes forever.
  let baseCommit: string
  try {
    baseCommit = await svc.resolveCommit(rt.cfg.repoPath, 'HEAD')
  } catch (e) {
    appendLog(rt.cfg.id, 'error', 'spawn', `spawn failed for ${eligibility.brief.id}: cannot resolve HEAD: ${msg(e)}`)
    toolResult(rt, { ok: false, error: { code: 'base-commit-unresolved', message: `Cannot resolve HEAD in ${rt.cfg.repoPath}: ${msg(e)}` } })
    return
  }
  const dispatch: RavelDispatchRecord = {
    briefId: eligibility.brief.id,
    planRevision: plan.revision,
    sessionId: null,
    branch,
    worktreePath,
    status: 'starting',
    startedAt: Date.now(),
    endedAt: null,
    baseCommit,
    usage: { inputTokens, outputTokens: 0, costUsd: null },
    report: null,
    contextRequests: 0,
    verification: null
  }
  saveConfig(rt, { ...rt.cfg, dispatches: [...rt.cfg.dispatches, dispatch] })
  updateConfig(rt, { usage: addUsage(rt.cfg.usage, { inputTokens, outputTokens: 0, costUsd: null }) })

  try {
    await svc.createWorktree(rt.cfg.repoPath, branch, {
      baseBranch: baseCommit,
      newBranch: true,
      targetPath: worktreePath
    })
    svc.trackWorktree(worktreePath, { repoId: rt.cfg.repoId, repoPath: rt.cfg.repoPath, branch })
    const afterWorktreeBlocked = spawnBlocker(rt)
    if (afterWorktreeBlocked) {
      if (rt.closing) {
        await removeUntouchedWorktree(rt, worktreePath, branch)
        replaceDispatch(rt, dispatch, { status: 'failed' })
      } else {
        replaceDispatch(rt, dispatch, { status: 'interrupted' })
        appendLog(rt.cfg.id, 'warn', 'spawn', `spawn interrupted for ${eligibility.brief.id}: ${afterWorktreeBlocked.message}`)
      }
      toolResult(rt, { ok: false, error: afterWorktreeBlocked })
      return
    }
    const child = await createChildSession(rt, eligibility.brief, dispatch, svc.getSettings(), prompt)
    const afterChildBlocked = spawnBlocker(rt)
    if (afterChildBlocked) {
      if (rt.closing) {
        replaceDispatch(rt, dispatch, { sessionId: child.id })
        appendLog(rt.cfg.id, 'warn', 'spawn', `child ${short(child.id)} created while Ravel is closing; queued delete will clean it up`, child.id)
      } else {
        svc.killSession(child.id)
        replaceDispatch(rt, dispatch, { sessionId: child.id, status: 'interrupted' })
        appendLog(rt.cfg.id, 'warn', 'spawn', `spawn interrupted after child creation for ${eligibility.brief.id}: ${afterChildBlocked.message}`, child.id)
      }
      toolResult(rt, { ok: false, error: afterChildBlocked })
      return
    }
    replaceDispatch(rt, dispatch, { sessionId: child.id, status: 'active' })
    watchChildRequests(rt, { ...dispatch, sessionId: child.id, status: 'active' })
    appendLog(rt.cfg.id, 'action', 'spawn', `spawned ${eligibility.brief.id} as child ${short(child.id)} on ${branch}`, child.id)
    toolResult(rt, { ok: true, childId: child.id, branch, worktreePath, briefId: eligibility.brief.id })
    emitChildrenChanged(rt.cfg.id)
    // After the dispatch is persisted as active, so a rule sees a real child.
    noteInsight('dispatch-created', rt.cfg.id)
  } catch (e) {
    replaceDispatch(rt, dispatch, { status: 'failed' })
    appendLog(rt.cfg.id, 'error', 'spawn', `spawn failed for ${eligibility.brief.id}: ${msg(e)}`)
    toolResult(rt, { ok: false, error: { code: 'spawn-failed', message: msg(e) } })
    await flushQueuedBriefs(rt)
  }
}
async function flushQueuedBriefs(rt: RavelRuntime): Promise<void> {
  while (!rt.closing && rt.cfg.status === 'running' && rt.queuedBriefs.length > 0 && liveChildCount(rt) < internalChildCapacity) {
    const briefId = rt.queuedBriefs.shift()
    if (!briefId) return
    await toolSpawnChild(rt, { tool: 'spawn_child', briefId })
  }
}

async function createChildSession(
  rt: RavelRuntime,
  brief: RavelBrief,
  dispatch: RavelDispatchRecord,
  settings: Settings,
  prompt: string
): Promise<Session> {
  const plan = rt.cfg.plan
  if (!plan || plan.approvedRevision !== dispatch.planRevision) throw new Error('approved plan changed before child launch')
  const req: CreateSessionRequest = {
    repoId: rt.cfg.repoId,
    repoPath: rt.cfg.repoPath,
    worktreePath: dispatch.worktreePath,
    branch: dispatch.branch,
    harness: brief.harness,
    model: brief.model ?? defaultModelForRole(brief.role, brief.harness),
    initialPrompt: prompt,
    kind: 'ravel-child',
    ravelId: rt.cfg.id,
    ravelRole: brief.role,
    briefId: brief.id,
    // Auto-approve (Claude's --dangerously-skip-permissions) is opt-in per Ravel:
    // ON only when the operator enabled allowRisky at creation. Default false.
    autoApprove: rt.cfg.allowRisky
  }
  return svc.createSession(req, settings)
}

function childPrompt(
  brief: RavelBrief,
  dependencyOutputMap: Partial<Record<string, string>>,
  orientation: string
): string {
  const lines = ['You are a Ravel child coding agent managed by Conductor.']
  // The only cross-brief context a child gets: enough to know what it is part
  // of, never enough to start doing somebody else's job.
  if (orientation.trim().length > 0) lines.push('', `WHAT THIS IS PART OF: ${orientation.trim()}`)
  lines.push(
    '',
    'Complete only the assigned brief. Do not broaden scope. Report your final result in the terminal when done.',
    'When you are done, write a short report to .conductor/report.md in this worktree:',
    'what you changed, the files you touched, and anything the next agent must know.',
    'Keep it under 40 lines. This file is the only thing downstream briefs will see.',
    '',
    `If your brief is missing something you need, write the question to ${CHILD_CHANNEL_DIR}/${CHILD_REQUEST_FILE}`,
    'and keep working on what you can. The orchestrator will answer in your terminal.',
    `Ask at most ${MAX_CONTEXT_REQUESTS} times, and only for what this brief needs.`,
    '',
    buildRolePrompt({ brief, dependencyOutputs: dependencyOutputMap })
  )
  return lines.join('\n')
}

function dependencyOutputs(cfg: RavelConfig, brief: RavelBrief): Partial<Record<string, string>> {
  const result: Partial<Record<string, string>> = {}
  for (const dependencyId of brief.dependsOn) {
    const completed = cfg.dispatches.find(
      (dispatch) =>
        dispatch.briefId === dependencyId &&
        dispatch.planRevision === cfg.plan?.revision &&
        dispatch.status === 'completed'
    )
    if (!completed) continue
    result[dependencyId] = completed.report ?? `${dependencyId} completed without a report`
  }
  return result
}

const MAX_REPORT_CHARS = 4_000

/** Missing or unreadable is normal — a child may crash or ignore the instruction. */
function readChildReport(worktreePath: string): string | null {
  try {
    const raw = readFileSync(join(worktreePath, CHILD_CHANNEL_DIR, 'report.md'), 'utf8').trim()
    return raw.length === 0 ? null : raw.slice(0, MAX_REPORT_CHARS)
  } catch {
    return null
  }
}

const MAX_VERIFY_OUTPUT_CHARS = 2_000
const VERIFY_TIMEOUT_MS = 600_000

/**
 * Per-repo replaces the global rather than appending to it: unlike a
 * post-create hook, two verify commands is not a longer script, it is the
 * wrong command for this repo followed by the right one.
 */
function verifyCommandFor(rt: RavelRuntime, settings: Settings): string {
  return (settings.verify.perRepo[rt.cfg.repoId] ?? settings.verify.global)?.trim() ?? ''
}

/**
 * The repo's own check, run in the finished child's worktree before the
 * manager hears about the exit — so the manager learns whether the change
 * holds up rather than only what the child claimed about it.
 *
 * Never throws. A verify command that cannot run is a failed verification,
 * not a failed child-exit. Abortable, because a paused, deleted or
 * budget-stopped Ravel must not leave a test suite running behind it.
 */
async function runVerification(
  rt: RavelRuntime,
  dispatch: RavelDispatchRecord,
  settings: Settings
): Promise<DispatchVerification | null> {
  const script = verifyCommandFor(rt, settings)
  if (script.length === 0) {
    rt.verifying.delete(dispatch.briefId)
    return null
  }

  // A configured verify command is arbitrary user shell: it runs only after the
  // operator has granted one-time consent. Without consent it is fail-closed —
  // a not-run verification, never a silent pass — so nothing lands unverified.
  if (!settings.shellHooksConsented) {
    const verification: DispatchVerification = {
      ok: false,
      output: 'verify not run — enable shell execution consent in Settings to run hooks and verify commands'
    }
    replaceDispatch(rt, dispatch, { verification })
    appendLog(
      rt.cfg.id,
      'error',
      'verify',
      `verify skipped (shell consent required) for ${dispatch.briefId}`,
      dispatch.sessionId ?? undefined
    )
    rt.verifying.delete(dispatch.briefId)
    emitChildrenChanged(rt.cfg.id)
    return verification
  }

  appendLog(rt.cfg.id, 'info', 'verify', `running verify for ${dispatch.briefId}`, dispatch.sessionId ?? undefined)
  const abort = new AbortController()
  rt.verifyAbort = abort
  let verification: DispatchVerification
  try {
    const res = await svc.runVerify(
      script,
      { worktreePath: dispatch.worktreePath, repoPath: rt.cfg.repoPath, branch: dispatch.branch },
      VERIFY_TIMEOUT_MS,
      abort.signal
    )
    verification = { ok: res.ok, output: clipTail(`${res.stdout}\n${res.stderr}`) }
  } catch (e) {
    verification = { ok: false, output: `verify command could not run: ${msg(e)}` }
  } finally {
    if (rt.verifyAbort === abort) rt.verifyAbort = undefined
    rt.verifying.delete(dispatch.briefId)
  }
  replaceDispatch(rt, dispatch, { verification })
  appendLog(
    rt.cfg.id,
    verification.ok ? 'info' : 'error',
    'verify',
    `verify ${verification.ok ? 'passed' : 'failed'} for ${dispatch.briefId}`,
    dispatch.sessionId ?? undefined
  )
  emitChildrenChanged(rt.cfg.id)
  noteInsight('verification-landed', rt.cfg.id)
  return verification
}

/** The tail, not the head: a failing command says why at the end. */
function clipTail(output: string): string {
  const trimmed = output.trim()
  if (trimmed.length === 0) return '(no output)'
  return trimmed.length > MAX_VERIFY_OUTPUT_CHARS ? trimmed.slice(-MAX_VERIFY_OUTPUT_CHARS) : trimmed
}

/**
 * Watches a child's worktree for a context request.
 *
 * A child cannot speak to the orchestrator directly — it is a third-party CLI
 * whose stdout is ANSI redraw we cannot parse reliably — so the channel is a
 * file it drops, mirroring the report convention that already works for all
 * three harnesses. The file is consumed on read so the same question is never
 * answered twice.
 */
function watchChildRequests(rt: RavelRuntime, dispatch: RavelDispatchRecord): void {
  const channelDir = join(dispatch.worktreePath, CHILD_CHANNEL_DIR)
  try {
    mkdirSync(channelDir, { recursive: true })
  } catch {
    return
  }
  let watcher: FSWatcher
  try {
    watcher = watch(channelDir, (_event, filename) => {
      if (filename !== null && String(filename) !== CHILD_REQUEST_FILE) return
      // The child is mid-write when the event fires; a beat avoids reading a
      // half-flushed file, and a missing file on re-read is simply ignored.
      setTimeout(() => consumeChildRequest(rt, dispatch), 120)
    })
  } catch {
    return
  }
  watcher.on('error', () => watcher.close())
  rt.requestWatchers.set(dispatch.sessionId ?? dispatch.branch, watcher)
}

function stopWatchingChildRequests(rt: RavelRuntime, key: string): void {
  const watcher = rt.requestWatchers.get(key)
  if (!watcher) return
  watcher.close()
  rt.requestWatchers.delete(key)
}

function consumeChildRequest(rt: RavelRuntime, dispatch: RavelDispatchRecord): void {
  const path = join(dispatch.worktreePath, CHILD_CHANNEL_DIR, CHILD_REQUEST_FILE)
  let question: string
  try {
    question = readFileSync(path, 'utf8').trim()
  } catch {
    return
  }
  try {
    unlinkSync(path)
  } catch {
    // Consumed anyway; a stale file would only re-ask the same question.
  }
  if (question.length === 0) return
  onChildContextRequest(rt, dispatch, question.slice(0, MAX_REQUEST_CHARS))
}

/**
 * A child asked for context. The orchestrator answers — never the child fetching
 * for itself — because deciding what a role is allowed to see is exactly the
 * judgement that makes the boundary worth having.
 */
function onChildContextRequest(rt: RavelRuntime, dispatch: RavelDispatchRecord, question: string): void {
  const current = rt.cfg.dispatches.find(
    (item) => item.branch === dispatch.branch && item.planRevision === dispatch.planRevision
  )
  if (!current || !LIVE_DISPATCH_STATUSES[current.status] || !current.sessionId) return

  // The cap exists to catch an AGENT looping on a mis-scoped brief. A person
  // asking their orchestrator five questions is doing the job properly, so a
  // human seat is counted but never cut off.
  const seat = svc.getSession(current.sessionId)?.harness === null
  const asked = current.contextRequests + 1
  replaceDispatch(rt, current, { contextRequests: asked })
  noteInsight('context-request', rt.cfg.id)
  appendLog(
    rt.cfg.id,
    'info',
    'context-request',
    seat
      ? `${current.briefId} asked for context (${asked}): ${question.slice(0, 160)}`
      : `${current.briefId} asked for context (${asked}/${MAX_CONTEXT_REQUESTS}): ${question.slice(0, 160)}`,
    current.sessionId
  )

  if (!seat && asked > MAX_CONTEXT_REQUESTS) {
    svc.writeToSession(
      current.sessionId,
      `Conductor: you have reached the limit of ${MAX_CONTEXT_REQUESTS} context requests for this brief. Work with what you have, or stop and explain what is missing in .conductor/report.md.\n`
    )
    appendLog(
      rt.cfg.id,
      'warn',
      'context-request',
      `${current.briefId} exceeded ${MAX_CONTEXT_REQUESTS} context requests — the brief was probably mis-scoped for its role`,
      current.sessionId
    )
    return
  }

  if (rt.closing || rt.cfg.status !== 'running') return
  const settings = svc.getSettings()
  updateConfig(rt, { activity: 'thinking' })
  enqueue(rt, () =>
    runManagerTurns(rt, settings, contextRequestDirective(current.briefId, current.sessionId as string, question))
  ).catch((e) => appendLog(rt.cfg.id, 'error', 'turn', `context-request turn failed: ${msg(e)}`))
}

/**
 * Last resort when a child wrote no report file. A model that ignored the
 * instruction still usually says what it did before exiting, and a truthful
 * transcript tail serves a dependent brief far better than "completed without
 * a report". Labelled so nobody mistakes it for something the child authored.
 */
function reportFromTail(tail: string): string | null {
  const trimmed = tail.trim()
  if (trimmed.length === 0) return null
  const body = trimmed.length > MAX_REPORT_CHARS ? trimmed.slice(-MAX_REPORT_CHARS) : trimmed
  return `(no report file; closing terminal output)\n${body}`
}

function replaceDispatch(
  rt: RavelRuntime,
  original: RavelDispatchRecord,
  patch: Partial<RavelDispatchRecord>
): RavelConfig {
  const dispatches = rt.cfg.dispatches.map((dispatch) =>
    dispatch.briefId === original.briefId &&
    dispatch.planRevision === original.planRevision &&
    dispatch.branch === original.branch &&
    dispatch.startedAt === original.startedAt
      ? { ...dispatch, ...patch }
      : dispatch
  )
  return saveConfig(rt, { ...rt.cfg, dispatches })
}

function toolMessageChild(rt: RavelRuntime, call: Record<string, unknown>): void {
  const childId = String(call.childId ?? '')
  const body = String(call.body ?? '').trim()
  const child = svc.getSession(childId)
  const dispatch = rt.cfg.dispatches.find(
    (item) => item.sessionId === childId && LIVE_DISPATCH_STATUSES[item.status]
  )
  // Ownership is proved by the live dispatch record plus the session's ravelId;
  // there is no manager session left to be the parent of.
  if (!child || child.kind !== 'ravel-child' || child.ravelId !== rt.cfg.id || !dispatch) {
    toolResult(rt, { ok: false, error: { code: 'unknown-child', message: 'unknown child for this Ravel runtime.' } })
    return
  }
  if (!body) {
    toolResult(rt, { ok: false, error: { code: 'directive-required', message: 'message_child requires a body.' } })
    return
  }
  const framed = `\n--- BEGIN RAVEL MANAGER DIRECTIVE ---\n${body}\n--- END RAVEL MANAGER DIRECTIVE ---\n\n`
  if (!svc.writeToSession(childId, framed)) {
    toolResult(rt, { ok: false, error: { code: 'child-write-failed', message: 'child session write failed.' } })
    return
  }
  appendLog(rt.cfg.id, 'action', 'message', `→ child ${short(childId)}: ${body.slice(0, 120)}`, childId)
  toolResult(rt, { ok: true })
}

function toolGetStatus(rt: RavelRuntime): void {
  const children = svc.listSessions()
    .filter((s) => s.kind === 'ravel-child' && s.ravelId === rt.cfg.id)
    .map((s) => ({
      childId: s.id,
      briefId: s.briefId,
      branch: s.branch,
      status: s.status,
      title: s.title,
      lastActivity: s.lastActivityAt,
      ageSec: Math.floor((Date.now() - s.lastActivityAt) / 1000)
    }))
  toolResult(rt, { ok: true, status: rt.cfg.status, activity: rt.cfg.activity, dispatches: rt.cfg.dispatches, children })
}

function toolComplete(rt: RavelRuntime, call: Record<string, unknown>): void {
  const plan = rt.cfg.plan
  if (!plan || plan.approvedRevision !== plan.revision) {
    toolResult(rt, { ok: false, error: { code: 'approved-plan-required', message: 'A current approved plan is required.' } })
    return
  }
  const completed = new Set(
    rt.cfg.dispatches
      .filter((dispatch) => dispatch.planRevision === plan.revision && dispatch.status === 'completed')
      .map((dispatch) => dispatch.briefId)
  )
  const missing = plan.briefs.map((brief) => brief.id).filter((briefId) => !completed.has(briefId))
  if (missing.length > 0) {
    toolResult(rt, { ok: false, error: { code: 'briefs-incomplete', message: `Incomplete briefs: ${missing.join(', ')}` } })
    return
  }
  // A child is persisted as completed the instant it exits, but its verdict
  // lands a moment later. Completing in that window would report a finished
  // fleet nobody had checked — and each pending verification ends in its own
  // manager turn, so refusing here costs nothing but a retry.
  if (rt.verifying.size > 0) {
    const pending = [...rt.verifying].join(', ')
    appendLog(rt.cfg.id, 'warn', 'complete', `completion held back: still verifying ${pending}`)
    toolResult(rt, {
      ok: false,
      error: {
        code: 'verification-pending',
        message: `Still verifying: ${pending}. You will get another turn when each verdict lands.`
      }
    })
    return
  }
  const summary = validateTranscriptContent(String(call.summary ?? 'Ravel completed the approved plan.'))
  if (!summary.ok) {
    toolResult(rt, { ok: false, error: summary.error })
    return
  }
  saveConfig(rt, {
    ...rt.cfg,
    status: 'completed',
    activity: 'idle',
    messages: trimMessages([
      ...rt.cfg.messages,
      { id: randomUUID(), author: 'ravel', body: summary.body, createdAt: Date.now(), delivery: 'delivered' }
    ], rt.cfg.plan)
  })
  appendLog(rt.cfg.id, 'info', 'complete', summary.body)
  noteInsight('ravel-completed', rt.cfg.id)
  toolResult(rt, { ok: true })
}

async function harnessAvailabilityRecord(settings: Settings): Promise<Record<HarnessId, HarnessAvailability>> {
  const list = await ctx.detectHarnesses(settings)
  const record = Object.fromEntries(
    (Object.keys(HARNESS_INFO) as HarnessId[]).map((id) => [
      id,
      { id, info: HARNESS_INFO[id], available: false, reason: `${HARNESS_INFO[id].label} not checked` }
    ])
  ) as Record<HarnessId, HarnessAvailability>
  for (const item of list) record[item.id] = item
  return record
}

export async function createRavel(req: CreateRavelRequest, settings: Settings): Promise<RavelActionResult> {
  const initialInstruction = req.initialInstruction === undefined ? null : validateTranscriptContent(req.initialInstruction)
  if (initialInstruction !== null && !initialInstruction.ok) return { ok: false, error: initialInstruction.error }
  const now = Date.now()
  const cfg: RavelConfig = {
    id: randomUUID(),
    name: 'Reigen',
    repoId: req.repoId,
    repoPath: req.repoPath,
    harness: req.harness,
    model: req.model?.trim() ? req.model.trim() : null,
    maxChildren: req.maxChildren && MAX_CHILDREN.has(req.maxChildren) ? req.maxChildren : DEFAULT_MAX_CHILDREN,
    allowRisky: !!req.allowRisky,
    status: 'idle',
    activity: 'idle',
    managerSessionId: null,
    messages: [],
    plan: null,
    dispatches: [],
    createdAt: now,
    error: null,
    usage: { ...EMPTY_RAVEL_USAGE }
  }
  const saved = svc.addRavel(cfg)
  const rt = ensureRuntime(saved)
  appendLog(saved.id, 'info', 'create', `Ravel "${saved.name}" created · harness ${HARNESS_INFO[saved.harness].label}`)
  if (initialInstruction !== null && initialInstruction.ok) {
    const ravel = await enqueue(rt, () => deliverUserMessage(rt, settings, initialInstruction.body, userDirective))
    return { ok: true, ravel }
  }
  return { ok: true, ravel: toPublicRavelConfig(saved) }
}

export function listRavel(): PublicRavelConfig[] {
  return svc.getRavel().map((cfg) => toPublicRavelConfig(cfg))
}

export function getRavel(id: string): PublicRavelConfig | undefined {
  const cfg = svc.getRavelById(id)
  return cfg ? toPublicRavelConfig(cfg) : undefined
}

function ravelClosingError(): { code: string; message: string } {
  return { code: 'ravel-closing', message: 'Ravel is closing.' }
}

/**
 * Persist a user message and run the manager turn it triggers.
 *
 * Delivery no longer depends on a live pty, so a message is delivered the
 * moment it is persisted; a failing turn is reported as a turn error and the
 * message stays in the transcript for the next attempt.
 */
async function deliverUserMessage(
  rt: RavelRuntime,
  settings: Settings,
  body: string,
  directive: (message: RavelMessage, cfg: RavelConfig) => string,
  beforeSave?: (cfg: RavelConfig) => RavelConfig
): Promise<PublicRavelConfig> {
  if (rt.closing) throw new Error('Ravel is closing.')
  const message: RavelMessage = { id: randomUUID(), author: 'user', body, createdAt: Date.now(), delivery: 'delivered' }
  const stagedBase = beforeSave ? beforeSave(rt.cfg) : rt.cfg
  saveConfig(rt, {
    ...stagedBase,
    activity: 'thinking',
    error: null,
    messages: trimMessages([...stagedBase.messages, message], stagedBase.plan)
  })
  appendLog(rt.cfg.id, 'action', 'message', `user message ${message.id} queued for the manager`)
  await runManagerTurns(rt, settings, directive(message, rt.cfg))
  return toPublicRavelConfig(rt.cfg)
}

function validateUserMessageBody(body: string): TranscriptValidationResult {
  return validateTranscriptContent(body)
}

export async function sendMessage(id: string, body: string, settings: Settings): Promise<RavelActionResult | undefined> {
  const rt = runtimeFor(id)
  if (!rt) return undefined
  if (rt.closing) return { ok: false, error: ravelClosingError() }
  const validation = validateUserMessageBody(body)
  if (!validation.ok) return { ok: false, error: validation.error }
  return enqueue(rt, async () => {
    if (rt.closing) return { ok: false, error: ravelClosingError() }
    return { ok: true, ravel: await deliverUserMessage(rt, settings, validation.body, userDirective) }
  })
}

/**
 * Redirect a child that is already running, without going around the
 * orchestrator. The note is recorded as what it is — the operator talking to
 * Ravel — and the manager turn it triggers decides what the child hears.
 */
export async function steerChild(
  id: string,
  sessionId: string,
  note: string,
  settings: Settings
): Promise<RavelActionResult | undefined> {
  const rt = runtimeFor(id)
  if (!rt) return undefined
  if (rt.closing) return { ok: false, error: ravelClosingError() }
  const validation = validateUserMessageBody(note)
  if (!validation.ok) return { ok: false, error: validation.error }
  return enqueue(rt, async () => {
    if (rt.closing) return { ok: false, error: ravelClosingError() }
    if (rt.cfg.status !== 'running') {
      return { ok: false, error: { code: 'ravel-not-running', message: 'Steering needs a running Ravel.' } }
    }
    const dispatch = rt.cfg.dispatches.find(
      (item) => item.sessionId === sessionId && LIVE_DISPATCH_STATUSES[item.status]
    )
    if (!dispatch) {
      return { ok: false, error: { code: 'unknown-child', message: 'No live child has that session id.' } }
    }
    // A steer costs a manager turn, so it is gated by the same ceiling that
    // gates every other turn — otherwise the cheapest way past the budget
    // would be to keep nudging children.
    if (budgetExceeded(rt.cfg, svc.getSettings())) {
      pauseForBudget(rt, svc.getSettings().tokenCeilingPerRavel)
      return { ok: false, error: { code: 'token-ceiling', message: 'token ceiling reached; ravel paused' } }
    }
    const ravel = await deliverUserMessage(rt, settings, validation.body, (message) =>
      steerDirective(dispatch.briefId, sessionId, message.body)
    )
    return { ok: true, ravel }
  })
}

export async function requestPlanChanges(
  id: string,
  planRevision: number,
  body: string,
  settings: Settings
): Promise<RavelActionResult | undefined> {
  const rt = runtimeFor(id)
  if (!rt) return undefined
  return enqueue(rt, async () => {
    if (rt.closing) return { ok: false, error: ravelClosingError() }
    const plan = rt.cfg.plan
    if (!plan) return { ok: false, error: { code: 'plan-required', message: 'A plan is required before requesting changes.' } }
    if (plan.revision !== planRevision) {
      return { ok: false, error: { code: 'stale-revision', currentRevision: plan.revision, requestedRevision: planRevision } }
    }
    const validation = validateUserMessageBody(body)
    if (!validation.ok) return { ok: false, error: validation.error }
    const ravel = await deliverUserMessage(
      rt,
      settings,
      validation.body,
      (message) => planChangesDirective(message, planRevision),
      (cfg) => ({
        ...cfg,
        status: 'awaiting-approval',
        activity: 'thinking',
        plan: cfg.plan ? { ...cfg.plan, approvedAt: null, approvedRevision: null } : cfg.plan
      })
    )
    appendLog(rt.cfg.id, 'action', 'plan-changes', `requested changes to revision ${planRevision}`)
    return { ok: true, ravel }
  })
}

export async function approvePlan(
  id: string,
  planRevision: number,
  settings: Settings
): Promise<RavelActionResult | undefined> {
  const rt = runtimeFor(id)
  if (!rt) return undefined
  return enqueue(rt, async () => {
    if (rt.closing) return { ok: false, error: ravelClosingError() }
    const approval = approveCurrentPlan(rt.cfg, { planRevision, now: Date.now() })
    if (!approval.ok) return { ok: false, error: approval.error }
    saveConfig(rt, { ...rt.cfg, plan: approval.plan, status: 'running', activity: 'thinking', error: null })
    appendLog(rt.cfg.id, 'action', 'approve', `approved plan revision ${planRevision}`)
    noteInsight('plan-approved', rt.cfg.id)
    await runManagerTurns(rt, settings, approvedPlanDirective(approval.plan))
    return { ok: true, ravel: toPublicRavelConfig(rt.cfg) }
  })
}

export async function applyBriefAssignment(
  id: string,
  planRevision: number,
  briefId: string,
  assignment: UpdateRavelBriefAssignmentRequest,
  settings: Settings
): Promise<RavelActionResult | undefined> {
  const rt = runtimeFor(id)
  if (!rt) return undefined
  return enqueue(rt, async () => {
    if (rt.closing) return { ok: false, error: ravelClosingError() }
    const result = applyBriefAssignmentToPlan(rt.cfg, {
      planRevision,
      briefId,
      assignment,
      now: Date.now(),
      fullContextChars: FULL_CONTEXT_CHARS,
      harnessAvailability: await harnessAvailabilityRecord(settings)
    })
    if (!result.ok) return { ok: false, error: result.error }
    const saved = saveConfig(rt, { ...rt.cfg, plan: result.plan, status: 'awaiting-approval', activity: 'idle' })
    appendLog(rt.cfg.id, 'action', 'assignment', `updated ${briefId} assignment in revision ${result.plan.revision}`)
    return { ok: true, ravel: toPublicRavelConfig(saved) }
  })
}

export async function retryCompilation(id: string, settings: Settings): Promise<RavelActionResult | undefined> {
  const rt = runtimeFor(id)
  if (!rt) return undefined
  return enqueue(rt, async () => {
    if (rt.closing) return { ok: false, error: ravelClosingError() }
    const lastSource = [...rt.cfg.messages].reverse().find((message) => message.author === 'user' && message.delivery === 'delivered')
    if (!lastSource) return { ok: false, error: { code: 'user-source-required', message: 'No delivered user source is available.' } }
    updateConfig(rt, { status: 'idle', activity: 'thinking', error: null })
    appendLog(rt.cfg.id, 'action', 'retry', `retrying from source ${lastSource.id}`)
    await runManagerTurns(rt, settings, retryDirective(lastSource))
    return { ok: true, ravel: toPublicRavelConfig(rt.cfg) }
  })
}

export async function resumeInterruptedBrief(
  id: string,
  planRevision: number,
  briefId: string,
  settings: Settings
): Promise<RavelActionResult | undefined> {
  const rt = runtimeFor(id)
  if (!rt) return undefined
  return enqueue(rt, async () => {
    if (rt.closing) return { ok: false, error: ravelClosingError() }
    const blocked = spawnBlocker(rt)
    if (blocked) return { ok: false, error: blocked }
    const eligibility = canResumeInterruptedBrief(rt.cfg, { briefId, planRevision })
    if (!eligibility.ok) return { ok: false, error: eligibility.error }
    if (eligibility.dispatch.sessionId && svc.getSession(eligibility.dispatch.sessionId)) {
      return { ok: false, error: { code: 'brief-already-live', message: 'The interrupted dispatch already has a live session.' } }
    }
    const plan = rt.cfg.plan
    const brief = plan?.briefs.find((candidate) => candidate.id === briefId)
    if (!plan || !brief) return { ok: false, error: { code: 'brief-not-found', message: 'The requested brief does not exist.' } }
    const beforeStartBlocked = spawnBlocker(rt)
    if (beforeStartBlocked) return { ok: false, error: beforeStartBlocked }
    // Resuming launches a second child for the same brief, so it costs a
    // second prompt. Both the gate and the meter belong here for the same
    // reason they belong in toolSpawnChild — this is a child launch.
    if (budgetExceeded(rt.cfg, svc.getSettings())) {
      pauseForBudget(rt, svc.getSettings().tokenCeilingPerRavel)
      return { ok: false, error: { code: 'token-ceiling', message: 'token ceiling reached; ravel paused' } }
    }
    const prompt = childPrompt(brief, dependencyOutputs(rt.cfg, brief), plan.orientation)
    const inputTokens = estimateTokens(prompt.length)
    const dispatches = rt.cfg.dispatches.map((dispatch) =>
      dispatch === eligibility.dispatch
        ? {
            ...dispatch,
            status: 'starting' as const,
            sessionId: null,
            // A second child for the same brief: the previous run's end time no
            // longer describes the dispatch that is now live.
            endedAt: null,
            usage: { ...dispatch.usage, inputTokens: dispatch.usage.inputTokens + inputTokens }
          }
        : dispatch
    )
    saveConfig(rt, { ...rt.cfg, dispatches })
    updateConfig(rt, { usage: addUsage(rt.cfg.usage, { inputTokens, outputTokens: 0, costUsd: null }) })
    try {
      const resumeDispatch = { ...eligibility.dispatch, status: 'starting' as const, sessionId: null }
      const child = await createChildSession(rt, brief, resumeDispatch, settings, prompt)
      const afterChildBlocked = spawnBlocker(rt)
      if (afterChildBlocked) {
        if (rt.closing) {
          const closingDispatches = rt.cfg.dispatches.map((dispatch) =>
            dispatch.briefId === briefId && dispatch.planRevision === planRevision && dispatch.branch === eligibility.branch
              ? { ...dispatch, sessionId: child.id }
              : dispatch
          )
          saveConfig(rt, { ...rt.cfg, dispatches: closingDispatches })
          appendLog(rt.cfg.id, 'warn', 'resume-brief', `child ${short(child.id)} created while Ravel is closing; queued delete will clean it up`, child.id)
        } else {
          svc.killSession(child.id)
          const interruptedDispatches = rt.cfg.dispatches.map((dispatch) =>
            dispatch.briefId === briefId && dispatch.planRevision === planRevision && dispatch.branch === eligibility.branch
              ? { ...dispatch, sessionId: eligibility.dispatch.sessionId, status: 'interrupted' as const }
              : dispatch
          )
          saveConfig(rt, { ...rt.cfg, dispatches: interruptedDispatches })
          appendLog(rt.cfg.id, 'warn', 'resume-brief', `resume interrupted after child creation for ${briefId}: ${afterChildBlocked.message}`, child.id)
        }
        return { ok: false, error: afterChildBlocked }
      }
      const updatedDispatches = rt.cfg.dispatches.map((dispatch) =>
        dispatch.briefId === briefId && dispatch.planRevision === planRevision && dispatch.branch === eligibility.branch
          ? { ...dispatch, sessionId: child.id, status: 'active' as const }
          : dispatch
      )
      const saved = saveConfig(rt, { ...rt.cfg, dispatches: updatedDispatches })
      watchChildRequests(rt, { ...resumeDispatch, sessionId: child.id, status: 'active' })
      appendLog(rt.cfg.id, 'action', 'resume-brief', `resumed ${briefId} in existing worktree`, child.id)
      emitChildrenChanged(rt.cfg.id)
      noteInsight('dispatch-created', rt.cfg.id)
      return { ok: true, ravel: toPublicRavelConfig(saved) }
    } catch (e) {
      const failedDispatches = rt.cfg.dispatches.map((dispatch) =>
        dispatch.briefId === briefId && dispatch.planRevision === planRevision && dispatch.branch === eligibility.branch
          ? { ...dispatch, status: 'failed' as const }
          : dispatch
      )
      const failed = saveConfig(rt, { ...rt.cfg, dispatches: failedDispatches })
      appendLog(rt.cfg.id, 'error', 'resume-brief', `resume failed for ${briefId}: ${msg(e)}`)
      return { ok: true, ravel: toPublicRavelConfig(failed) }
    }
  })
}

/**
 * Stops the ravel the way the budget gate does: abort the manager turn AND kill
 * every live child.
 *
 * Leaving children running was actively dangerous, not merely surprising. The
 * ceiling is only enforced in `onSessionProgress` while `status === 'running'`, so
 * a manual pause used to keep billing the orphaned children with the automatic
 * stop switched off. Children are marked `interrupted`, so worktrees survive and
 * each brief stays resumable — the work is suspended, never discarded.
 */
export function pauseRavel(id: string): PublicRavelConfig | undefined {
  const rt = runtimeFor(id)
  if (!rt) return undefined
  rt.cfg = { ...rt.cfg, status: 'paused', activity: 'idle' }
  rt.turnAbort?.abort()
  rt.verifyAbort?.abort()
  const stopped = stopLiveChildren(rt)
  const saved = updateConfig(rt, { status: 'paused', activity: 'idle' })
  appendLog(
    id,
    'info',
    'pause',
    `Ravel paused${stopped === 0 ? '' : ` · stopped ${stopped} live child${stopped === 1 ? '' : 'ren'}`}`
  )
  return toPublicRavelConfig(saved)
}

export async function resumeRavel(id: string, settings: Settings): Promise<PublicRavelConfig | undefined> {
  const rt = runtimeFor(id)
  if (!rt) return undefined
  if (rt.closing) return undefined
  return enqueue(rt, async () => {
    const status = hasApprovedPlan(rt.cfg) ? 'running' : rt.cfg.plan ? 'awaiting-approval' : 'idle'
    saveConfig(rt, { ...rt.cfg, status, activity: 'thinking', error: null })
    appendLog(id, 'info', 'resume', 'Ravel resumed; interrupted children were not relaunched')
    await runManagerTurns(rt, settings, resumeDirective(rt.cfg))
    // Pausing interrupts every live child, so capacity reopens on resume. Any
    // brief that was queued (never started) before the pause would otherwise
    // strand behind the already-queued guard forever — drain now that slots are free.
    await flushQueuedBriefs(rt)
    return toPublicRavelConfig(rt.cfg)
  })
}

/**
 * Archive a TERMINAL dispatch so it drops out of the fleet/worker views. The
 * record is retained in the stored config (insights keep it) — only its public
 * projection is hidden. A live dispatch must be stopped first; archiving one
 * would strand a running child, so it throws instead.
 *
 * Returns undefined when the ravel is unknown (caller maps to "not live");
 * throws when the session owns no dispatch or the dispatch is still live.
 */
export function archiveDispatch(ravelId: string, sessionId: string): PublicRavelConfig | undefined {
  const rt = runtimeFor(ravelId)
  if (!rt) return undefined
  const dispatch = rt.cfg.dispatches.find((d) => d.sessionId === sessionId)
  if (!dispatch) throw new Error(`no dispatch for session "${sessionId}" in ravel "${ravelId}"`)
  if (LIVE_DISPATCH_STATUSES[dispatch.status]) {
    throw new Error(`worker "${sessionId}" is still live; stop it before archiving`)
  }
  const saved = replaceDispatch(rt, dispatch, { archived: true })
  appendLog(ravelId, 'info', 'archive', `archived ${dispatch.briefId} (${dispatch.branch})`)
  return toPublicRavelConfig(saved)
}

/**
 * Detach a LIVE ravel-child from the ravel, per the operations design's `detach`
 * control. The running agent is handed to the operator: its session is PROMOTED
 * to a standalone `normal` session (the pty and worktree keep running — detach is
 * not a kill), the dispatch becomes terminal `detached` with its `sessionId`
 * cleared so the ravel no longer owns it, and no report is published, so
 * dependent briefs stay blocked. The manager then receives an explicit replan
 * event so it can reassign or drop the brief.
 *
 * Returns undefined when the ravel is unknown; throws when the session owns no
 * dispatch or the dispatch is not live.
 */
export async function detachChild(
  ravelId: string,
  sessionId: string,
  settings: Settings
): Promise<PublicRavelConfig | undefined> {
  const rt = runtimeFor(ravelId)
  if (!rt) return undefined
  const dispatch = rt.cfg.dispatches.find((d) => d.sessionId === sessionId)
  if (!dispatch) throw new Error(`no dispatch for session "${sessionId}" in ravel "${ravelId}"`)
  if (!LIVE_DISPATCH_STATUSES[dispatch.status]) {
    throw new Error(`worker "${sessionId}" is not live; nothing to detach`)
  }
  stopWatchingChildRequests(rt, sessionId)
  // Hand the running agent to the operator before the ravel lets go of it.
  const promoted = svc.promoteToStandalone(sessionId)
  const saved = replaceDispatch(rt, dispatch, { status: 'detached', endedAt: Date.now(), sessionId: null })
  const dependents = (rt.cfg.plan?.briefs ?? [])
    .filter((b) => b.dependsOn.includes(dispatch.briefId))
    .map((b) => b.id)
  appendLog(
    ravelId,
    'info',
    'detach',
    `detached ${dispatch.briefId} (${dispatch.branch})${promoted ? '; promoted child to a standalone session' : ''}` +
      (dependents.length > 0 ? ` · blocks ${dependents.join(', ')}` : '')
  )
  emitChildrenChanged(ravelId)
  // Explicit event so the manager can propose a revised plan around the gap.
  // Detaching frees a live slot; queued briefs advance into it after the replan
  // turn, the same way they do when a child exits or fails to start.
  enqueue(rt, async () => {
    await runManagerTurns(rt, settings, detachedChildDirective(dispatch.briefId, dependents))
    await flushQueuedBriefs(rt)
  }).catch((e) =>
    appendLog(ravelId, 'error', 'turn', `detach replan turn failed: ${msg(e)}`)
  )
  return toPublicRavelConfig(saved)
}

/** The replan directive delivered to the manager after an operator detaches a child. */
function detachedChildDirective(briefId: string, dependents: string[]): string {
  return [
    `EVENT: the operator detached the child working ${briefId}; it is now a standalone session you no longer control.`,
    'Its dispatch is terminal (detached) with no report, and it satisfied no dependency.',
    dependents.length === 0
      ? 'No briefs depend on it.'
      : `These briefs depend on it and are now blocked: ${dependents.join(', ')}.`,
    'Propose a revised plan (reassign or drop the brief) or reply with how you will proceed.'
  ].join('\n')
}

export async function deleteRavel(id: string): Promise<void> {
  const rt = runtimeFor(id)
  if (!rt) {
    logs.delete(id)
    svc.removeRavel(id)
    emitChildrenChanged(id)
    return
  }
  if (rt.closing) {
    await rt.queue.catch(() => undefined)
    return
  }
  rt.closing = true
  rt.turnAbort?.abort()
  rt.verifyAbort?.abort()
  await enqueue(rt, async () => {
    for (const child of svc.listSessions().filter((s) => s.kind === 'ravel-child' && s.ravelId === id)) {
      stopWatchingChildRequests(rt, child.id)
      svc.killSession(child.id)
    }
    runtimes.delete(id)
    logs.delete(id)
    svc.removeRavel(id)
    emitChildrenChanged(id)
  })
}


/**
 * Bills a live child's output as it accrues.
 *
 * Without this the ceiling only settles when a child exits, so a single
 * runaway session can spend without bound and the pill sits frozen while it
 * does. Deltas land on the dispatch, so exit can reconcile against them
 * instead of double-counting.
 */
export function onSessionProgress(sessionId: string, deltaChars: number): void {
  const tokens = estimateTokens(deltaChars)
  if (tokens === 0) return
  for (const cfg of svc.getRavel()) {
    const dispatch = cfg.dispatches.find(
      (item) => item.sessionId === sessionId && LIVE_DISPATCH_STATUSES[item.status]
    )
    if (!dispatch) continue
    const rt = ensureRuntime(cfg)
    const brief = cfg.plan?.briefs.find((item) => item.id === dispatch.briefId) ?? null
    const outputTokens = dispatch.usage.outputTokens + tokens
    const dispatches = cfg.dispatches.map((item) =>
      item === dispatch
        ? {
            ...item,
            usage: {
              inputTokens: item.usage.inputTokens,
              outputTokens,
              costUsd: estimateCostUsd(
                brief?.model == null ? null : splitModel(brief.model).model,
                item.usage.inputTokens,
                outputTokens
              )
            }
          }
        : item
    )
    saveConfig(rt, { ...cfg, dispatches })
    updateConfig(rt, {
      usage: addUsage(rt.cfg.usage, { inputTokens: 0, outputTokens: tokens, costUsd: null })
    })
    if (!rt.closing && rt.cfg.status === 'running' && budgetExceeded(rt.cfg, svc.getSettings())) {
      pauseForBudget(rt, svc.getSettings().tokenCeilingPerRavel)
    }
  }
}

/**
 * A child exiting is the only free progress signal the on-demand manager gets,
 * so it is also the event that lets a fleet advance without the user acting.
 */
export function onSessionExit(sessionId: string, result: SessionExitResult): void {
  for (const cfg of svc.getRavel()) {
    const rt = ensureRuntime(cfg)
    const dispatch = cfg.dispatches.find((item) => item.sessionId === sessionId && LIVE_DISPATCH_STATUSES[item.status])
    if (!dispatch) continue
    const completed = result.exitCode === 0
    const brief = cfg.plan?.briefs.find((item) => item.id === dispatch.briefId) ?? null
    const outputTokens = estimateTokens(result.outputChars)
    // Live progress already billed part of this child; charge only the rest.
    const unbilled = Math.max(0, outputTokens - dispatch.usage.outputTokens)
    const totalUsage: RavelUsage = {
      inputTokens: dispatch.usage.inputTokens,
      outputTokens,
      costUsd: estimateCostUsd(
        brief?.model == null ? null : splitModel(brief.model).model,
        dispatch.usage.inputTokens,
        outputTokens
      )
    }
    // Two different audiences, deliberately. `report` is the artifact the child
    // chose to publish; it is persisted and it is the ONLY thing a dependent
    // brief may see. The transcript tail goes to the manager alone, which
    // already holds the whole picture — a sibling's raw screen routinely echoes
    // its own brief back, and routing that to a dependent would hand one child
    // another's context.
    stopWatchingChildRequests(rt, sessionId)
    const report = readChildReport(dispatch.worktreePath)
    const dispatches = cfg.dispatches.map((item) =>
      item === dispatch
        ? {
            ...item,
            status: completed ? ('completed' as const) : ('failed' as const),
            endedAt: Date.now(),
            usage: totalUsage,
            report
          }
        : item
    )
    const saved = saveConfig(rt, { ...cfg, dispatches })
    updateConfig(rt, {
      usage: addUsage(rt.cfg.usage, { inputTokens: 0, outputTokens: unbilled, costUsd: totalUsage.costUsd })
    })
    appendLog(saved.id, completed ? 'info' : 'error', 'child-exit', `${dispatch.briefId} ${completed ? 'completed' : 'failed'}`, sessionId)
    emitChildrenChanged(saved.id)
    // After both the dispatch and the usage are persisted: a rule that reads
    // spend must not see a half-written exit.
    noteInsight('child-exit', saved.id)
    if (rt.closing || rt.cfg.status !== 'running') continue
    const settings = svc.getSettings()
    updateConfig(rt, { activity: 'thinking' })
    const managerBriefing = report ?? reportFromTail(result.tail)
    const exited = rt.cfg.dispatches.find(
      (item) =>
        item.briefId === dispatch.briefId &&
        item.planRevision === dispatch.planRevision &&
        item.branch === dispatch.branch &&
        item.startedAt === dispatch.startedAt
    )
    // Registered synchronously, before anything is queued: a sibling exiting a
    // millisecond later must already see that this brief's verdict is pending,
    // or its manager turn could call complete on an unverified fleet.
    const verifyPending = verifyCommandFor(rt, settings).length > 0
    if (verifyPending && exited) rt.verifying.add(dispatch.briefId)
    enqueue(rt, async () => {
      const verification = exited ? await runVerification(rt, exited, settings) : null
      // The verify command can take minutes, and the Ravel may have been
      // paused, deleted or stopped at the ceiling while it ran. The verdict is
      // already persisted; what must not happen is dragging a stopped Ravel
      // back into a turn.
      if (rt.closing || rt.cfg.status !== 'running') {
        appendLog(saved.id, 'info', 'child-exit', `${dispatch.briefId} verified after the Ravel stopped; no turn taken`, sessionId)
        return
      }
      updateConfig(rt, { activity: 'thinking' })
      await runManagerTurns(
        rt,
        settings,
        childExitDirective(dispatch.briefId, completed, rt.cfg.plan, managerBriefing, verification)
      )
      await flushQueuedBriefs(rt)
    }).catch((e) => {
      rt.verifying.delete(dispatch.briefId)
      appendLog(saved.id, 'error', 'turn', `child-exit turn failed: ${msg(e)}`)
    })
  }
}

export function childrenOf(ravelId: string): Session[] {
  return svc.listSessions().filter((s) => s.kind === 'ravel-child' && s.ravelId === ravelId)
}

export function reattachOnStartup(): void {
  for (const cfg of svc.getRavel()) {
    if (runtimes.has(cfg.id)) continue
    const interrupted = interruptLiveDispatchesForRestart(cfg)
    const saved = svc.replaceRavel(cfg.id, interrupted) ?? interrupted
    ensureRuntime(saved)
    appendLog(saved.id, 'info', 'reattach', 'restored from disk (paused; live dispatches were interrupted)')
  }
}

// --- Human seats -------------------------------------------------------
//
// A terminal the operator works in, sitting in the fleet as a peer of the
// agents. Everything below reuses the child protocol rather than inventing a
// parallel one: the brief arrives as a file in the worktree, questions go out
// through `.conductor/request.md`, and finishing writes the same report a child
// would. The only thing a human needs that an agent does not is an explicit
// "done", because a person should not have to close their shell to signal it.

const BRIEF_FILE = 'brief.md'

/** Written into the worktree so the brief is readable without leaving the shell. */
function writeBriefFile(worktreePath: string, brief: RavelBrief, orientation: string): string {
  const path = join(worktreePath, CHILD_CHANNEL_DIR, BRIEF_FILE)
  const body = [
    `# ${brief.title}`,
    '',
    `Role: ${brief.role}`,
    '',
    '## Goal',
    brief.goal,
    '',
    ...(orientation.trim().length > 0 ? ['## Orientation', orientation, ''] : []),
    ...(brief.acceptanceCriteria.length > 0
      ? ['## Acceptance', ...brief.acceptanceCriteria.map((item) => `- ${item}`), '']
      : []),
    ...(brief.doNotTouch.length > 0
      ? ['## Do not touch', ...brief.doNotTouch.map((item) => `- ${item}`), '']
      : []),
    '## Reporting',
    'Use "Ask orchestrator" for a question and "Finish brief" when you are done.',
    'Both are in this session header; neither needs you to close the shell.'
  ].join('\n')
  mkdirSync(join(worktreePath, CHILD_CHANNEL_DIR), { recursive: true })
  writeFileSync(path, body, 'utf8')
  return path
}

/**
 * Take a brief yourself: a worktree, a shell in it, and a seat in the fleet.
 *
 * Deliberately not reachable by the manager. `spawn_child` can only dispatch
 * something it can invoke, and a shell is not that — a seat is always claimed.
 */
export async function claimBrief(
  id: string,
  planRevision: number,
  briefId: string,
  settings: Settings
): Promise<RavelActionResult | undefined> {
  const rt = runtimeFor(id)
  if (!rt) return undefined
  return enqueue(rt, async () => {
    if (rt.closing) return { ok: false, error: ravelClosingError() }
    const plan = rt.cfg.plan
    const brief = plan?.briefs.find((candidate) => candidate.id === briefId)
    if (!plan || !brief) {
      return { ok: false, error: { code: 'brief-not-found', message: 'The requested brief does not exist.' } }
    }
    if (plan.approvedRevision !== planRevision) {
      return { ok: false, error: { code: 'approved-plan-required', message: 'Approve the current plan revision first.' } }
    }
    const live = rt.cfg.dispatches.find(
      (item) => item.briefId === briefId && LIVE_DISPATCH_STATUSES[item.status]
    )
    if (live) {
      return { ok: false, error: { code: 'brief-already-live', message: 'That brief is already being worked.' } }
    }

    const branch = `ravel/${slug(briefId)}-${randomBytes(3).toString('hex')}`
    const worktreePath = svc.worktreePathFor(rt.cfg.repoPath, branch, ctx.resolveWorktreeRoot())
    let baseCommit: string
    try {
      baseCommit = await svc.resolveCommit(rt.cfg.repoPath, 'HEAD')
    } catch (e) {
      return { ok: false, error: { code: 'base-commit-unresolved', message: msg(e) } }
    }

    // A seat costs no tokens: nothing is prompted and nothing is generated.
    const dispatch: RavelDispatchRecord = {
      briefId,
      planRevision,
      sessionId: null,
      branch,
      worktreePath,
      status: 'starting',
      startedAt: Date.now(),
      endedAt: null,
      baseCommit,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: null },
      report: null,
      contextRequests: 0,
      verification: null
    }
    saveConfig(rt, { ...rt.cfg, dispatches: [...rt.cfg.dispatches, dispatch] })

    try {
      await svc.createWorktree(rt.cfg.repoPath, branch, {
        baseBranch: baseCommit,
        newBranch: true,
        targetPath: worktreePath
      })
      svc.trackWorktree(worktreePath, { repoId: rt.cfg.repoId, repoPath: rt.cfg.repoPath, branch })
      const briefPath = writeBriefFile(worktreePath, brief, plan.orientation)

      const session = await svc.createSession(
        {
          repoId: rt.cfg.repoId,
          repoPath: rt.cfg.repoPath,
          worktreePath,
          branch,
          // The seat's shell. No agent, no model, no prompt.
          harness: null,
          title: `You · ${brief.title}`,
          kind: 'ravel-child',
          ravelId: rt.cfg.id,
          ravelRole: brief.role,
          briefId
        },
        settings
      )
      replaceDispatch(rt, dispatch, { sessionId: session.id, status: 'active' })
      watchChildRequests(rt, { ...dispatch, sessionId: session.id, status: 'active' })
      // A shell takes no prompt argument, so the brief is announced in the
      // terminal instead — a path the operator can open, not a wall of text.
      svc.writeToSession(session.id, `# Brief: ${brief.title}\r`)
      svc.writeToSession(session.id, `# ${briefPath}\r`)
      appendLog(rt.cfg.id, 'action', 'spawn', `${briefId} claimed by the operator on ${branch}`, session.id)
      emitChildrenChanged(rt.cfg.id)
      noteInsight('dispatch-created', rt.cfg.id)
      return { ok: true, ravel: toPublicRavelConfig(rt.cfg) }
    } catch (e) {
      replaceDispatch(rt, dispatch, { status: 'failed' })
      appendLog(rt.cfg.id, 'error', 'spawn', `claim failed for ${briefId}: ${msg(e)}`)
      return { ok: false, error: { code: 'claim-failed', message: msg(e) } }
    }
  })
}

/** Find the ravel and dispatch a seat's session belongs to. */
function seatOf(sessionId: string): { rt: RavelRuntime; dispatch: RavelDispatchRecord } | null {
  for (const cfg of svc.getRavel()) {
    const dispatch = cfg.dispatches.find(
      (item) => item.sessionId === sessionId && LIVE_DISPATCH_STATUSES[item.status]
    )
    if (dispatch) return { rt: ensureRuntime(cfg), dispatch }
  }
  return null
}

/**
 * A seat asking the orchestrator a question.
 *
 * Goes through the same file the agents use, so there is one channel and one
 * set of semantics. The per-brief request cap is not applied: it exists to catch
 * a mis-scoped agent looping, and a person asking five questions is doing the
 * job properly.
 */
export function askFromSeat(sessionId: string, question: string): boolean {
  const seat = seatOf(sessionId)
  if (seat === null) return false
  const trimmed = question.trim()
  if (trimmed.length === 0) return false
  try {
    mkdirSync(join(seat.dispatch.worktreePath, CHILD_CHANNEL_DIR), { recursive: true })
    writeFileSync(
      join(seat.dispatch.worktreePath, CHILD_CHANNEL_DIR, CHILD_REQUEST_FILE),
      trimmed.slice(0, MAX_REQUEST_CHARS),
      'utf8'
    )
  } catch {
    return false
  }
  return true
}

/**
 * A seat declaring its brief finished.
 *
 * The completion signal an agent gets for free by exiting. Everything after this
 * point — the report, the verify command, the manager's next turn — is the path
 * a child exit already takes, because a seat is a peer and not a special case.
 */
export function finishSeat(sessionId: string, report: string, failed = false): boolean {
  const seat = seatOf(sessionId)
  if (seat === null) return false
  const { rt, dispatch } = seat
  const written = report.trim()
  if (written.length > 0) {
    try {
      mkdirSync(join(dispatch.worktreePath, CHILD_CHANNEL_DIR), { recursive: true })
      writeFileSync(
        join(dispatch.worktreePath, CHILD_CHANNEL_DIR, 'report.md'),
        written.slice(0, MAX_REPORT_CHARS),
        'utf8'
      )
    } catch {
      // A report that cannot be written is not a reason to strand the brief.
    }
  }
  stopWatchingChildRequests(rt, sessionId)
  const finalReport = readChildReport(dispatch.worktreePath)
  const dispatches = rt.cfg.dispatches.map((item) =>
    item === dispatch || (item.briefId === dispatch.briefId && item.startedAt === dispatch.startedAt)
      ? {
          ...item,
          status: failed ? ('failed' as const) : ('completed' as const),
          endedAt: Date.now(),
          report: finalReport
        }
      : item
  )
  const saved = saveConfig(rt, { ...rt.cfg, dispatches })
  appendLog(
    saved.id,
    failed ? 'error' : 'info',
    'child-exit',
    `${dispatch.briefId} ${failed ? 'abandoned' : 'finished'} by the operator`,
    sessionId
  )
  emitChildrenChanged(saved.id)
  noteInsight('child-exit', saved.id)

  if (rt.closing || rt.cfg.status !== 'running') return true
  const settings = svc.getSettings()
  const finished = rt.cfg.dispatches.find(
    (item) => item.briefId === dispatch.briefId && item.startedAt === dispatch.startedAt
  )
  const verifyPending = verifyCommandFor(rt, settings).length > 0
  if (verifyPending && finished) rt.verifying.add(dispatch.briefId)
  updateConfig(rt, { activity: 'thinking' })
  enqueue(rt, async () => {
    const verification = finished ? await runVerification(rt, finished, settings) : null
    if (rt.closing || rt.cfg.status !== 'running') return
    updateConfig(rt, { activity: 'thinking' })
    await runManagerTurns(
      rt,
      settings,
      childExitDirective(dispatch.briefId, !failed, rt.cfg.plan, finalReport ?? 'The operator reported nothing.', verification)
    )
  }).catch((e) => {
    rt.verifying.delete(dispatch.briefId)
    appendLog(saved.id, 'error', 'turn', `seat-finish turn failed: ${msg(e)}`)
  })
  return true
}
