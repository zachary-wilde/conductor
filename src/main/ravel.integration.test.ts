import { afterEach, describe, expect, test, vi } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_SETTINGS,
  HARNESS_INFO,
  type CreateSessionRequest,
  type HarnessAvailability,
  type HarnessId,
  type PublicRavelConfig,
  type RavelConfig,
  type Session,
  type Settings
} from '@shared/types'
import {
  approvePlan,
  createRavel,
  deleteRavel,
  getLog,
  getRavel,
  onSessionExit,
  onSessionProgress,
  pauseRavel,
  resumeInterruptedBrief,
  resumeRavel,
  sendMessage,
  setInsightNotifier,
  setRavelContext,
  setInternalChildCapacityForTest,
  setRavelRuntimeServicesForTest,
  steerChild,
  archiveDispatch,
  detachChild,
  claimBrief,
  askFromSeat,
  finishSeat
} from './ravel'
import { MAX_ORIENTATION_CHARS } from './ravel-model'
import type { HookResult } from './hooks'
import type { InsightTrigger } from './insights/types'

/**
 * End-to-end orchestration proof with zero AI quota spend: no harness process,
 * no git worktree, no Electron, and no real store. Every process-touching
 * dependency is a fake injected through the Ravel runtime services seam.
 *
 * The manager is now a headless per-turn invocation, so the seam under test is
 * `runHeadlessHarness`: the fake returns scripted stdout for each prompt, which
 * is exactly what a real CLI print-mode turn hands back.
 */

// The fixture operator has granted shell-execution consent, so hooks/verify run;
// the unconsented path is covered by its own test.
const SETTINGS: Settings = { ...DEFAULT_SETTINGS, harnessModels: { claude: 'opus' }, shellHooksConsented: true }

const MISSION_CONTEXT = 'Users reported auth drops after refresh'
const USER_SECRET_ASK = 'Rotate the signing key too'

function available(id: 'claude' | 'codex'): HarnessAvailability {
  return {
    id,
    info: HARNESS_INFO[id],
    available: true,
    resolved: { id, command: id, args: [], resolvedFrom: `C:/bin/${id}.exe` }
  }
}

function sessionFrom(req: CreateSessionRequest, id: string): Session {
  const now = Date.now()
  const base = {
    id,
    repoId: req.repoId,
    repoPath: req.repoPath,
    worktreePath: req.worktreePath,
    branch: req.branch,
    // harness is set per-variant below: only a ravel child is guaranteed an agent.
    status: 'running' as const,
    title: req.initialPrompt ? req.initialPrompt.slice(0, 40) : null,
    initialPrompt: req.initialPrompt ?? null,
    createdAt: now,
    lastActivityAt: now,
    lastOutputAt: null
  }
  if (req.kind === 'ravel-child') {
    return { ...base, harness: req.harness, kind: 'ravel-child', parentId: null, ravelId: req.ravelId, ravelRole: req.ravelRole, briefId: req.briefId }
  }
  return { ...base, harness: req.harness, kind: 'normal', parentId: null, ravelId: null, ravelRole: null, briefId: null }
}

function toolBlock(payload: Record<string, unknown>): string {
  return '```conductor-tool\n' + JSON.stringify(payload) + '\n```\n'
}

/** Wraps scripted output the way a real TUI-ish CLI decorates its stdout. */
function withAnsi(body: string): string {
  return `\u001b[?25l\u001b[32mthinking\u001b[0m\n${body}\u001b[?25h\n`
}

interface Fake {
  created: CreateSessionRequest[]
  sessions: Session[]
  writes: Record<string, string[]>
  killed: string[]
  worktrees: string[]
  records: Map<string, RavelConfig>
  /** Every prompt the manager was invoked with, in order. */
  prompts: string[]
  /** Scripted stdout, consumed one entry per invocation. */
  script: string[]
  /** Per-harness one-shot failure: the next turn on that harness throws this message, then clears. */
  throwOnce: Map<HarnessId, string>
  /** Every verify command the runtime ran, with where it ran it. */
  verifies: { script: string; worktreePath: string; repoPath: string; branch: string }[]
}

/** Settings the runtime reads for itself (spawn guards), as opposed to the
 *  settings an entrypoint is called with. A test may diverge the two. */
let settingsOverride: Settings | null = null
const DEFAULT_WORKTREE_BASE = 'C:/worktrees'
let worktreeBase = DEFAULT_WORKTREE_BASE
/** Fires inside createWorktree, to simulate the user acting mid-spawn. */
let onCreateWorktree: (() => void) | null = null
/** When set, the next createWorktree throws once — used to exercise fail-start draining. */
let failNextWorktree = false
/**
 * Scripted result of the repo's verify command. Return a promise to hold the
 * verdict open, which is how the ordering guarantee is tested; throw to
 * simulate a runner that cannot start at all.
 */
let verifyOutcome: (script: string) => HookResult | Promise<HookResult> = () => ({
  ok: true,
  exitCode: 0,
  stdout: 'ok',
  stderr: '',
  ranWith: 'fake'
})

function harness(): Fake {
  const fake: Fake = {
    created: [],
    sessions: [],
    writes: {},
    killed: [],
    worktrees: [],
    records: new Map(),
    prompts: [],
    script: [],
    throwOnce: new Map(),
    verifies: []
  }

  setRavelContext({
    resolveWorktreeRoot: () => 'C:/worktrees',
    emit: () => undefined,
    detectHarnesses: async () => [available('claude'), available('codex')]
  })

  setRavelRuntimeServicesForTest({
    createSession: async (req) => {
      fake.created.push(req)
      const session = sessionFrom(req, `child-${fake.sessions.length}`)
      fake.sessions.push(session)
      fake.writes[session.id] = []
      return session
    },
    getSession: (id) => fake.sessions.find((session) => session.id === id),
    listSessions: () => fake.sessions,
    writeToSession: (id, data) => {
      if (!fake.writes[id]) return false
      fake.writes[id].push(data)
      return true
    },
    killSession: (id) => {
      fake.killed.push(id)
      return true
    },
    promoteToStandalone: (id) => {
      const idx = fake.sessions.findIndex((s) => s.id === id)
      if (idx < 0 || fake.sessions[idx].kind !== 'ravel-child') return undefined
      const promoted = {
        ...fake.sessions[idx],
        kind: 'normal',
        parentId: null,
        ravelId: null,
        ravelRole: null,
        briefId: null
      } as Session
      fake.sessions[idx] = promoted
      return promoted
    },
    runHeadlessHarness: async (id, _settings, prompt) => {
      fake.prompts.push(prompt)
      const dry = fake.throwOnce.get(id)
      if (dry !== undefined) {
        fake.throwOnce.delete(id)
        throw new Error(dry)
      }
      return fake.script.shift() ?? 'I have nothing to do.'
    },
    createWorktree: async (_repoPath, _branch, opts) => {
      if (failNextWorktree) {
        failNextWorktree = false
        throw new Error('worktree boom')
      }
      const path = opts?.targetPath ?? `${worktreeBase}/fallback`
      fake.worktrees.push(path)
      if (worktreeBase !== DEFAULT_WORKTREE_BASE) mkdirSync(path, { recursive: true })
      onCreateWorktree?.()
      return path
    },
    removeWorktree: async () => undefined,
    currentBranch: async () => 'main',
    resolveCommit: async () => 'f'.repeat(40),
    worktreePathFor: (_repoPath, branch) => `${worktreeBase}/${branch.replace(/[\\/]/g, '-')}`,
    trackWorktree: () => undefined,
    untrackWorktree: () => undefined,
    getSettings: () => settingsOverride ?? SETTINGS,
    getRavel: () => [...fake.records.values()],
    getRavelById: (id) => fake.records.get(id),
    addRavel: (cfg) => {
      fake.records.set(cfg.id, cfg)
      return cfg
    },
    replaceRavel: (id, cfg) => {
      if (!fake.records.has(id)) return undefined
      fake.records.set(id, cfg)
      return cfg
    },
    updateRavel: (id, patch) => {
      const current = fake.records.get(id)
      if (!current) return undefined
      const next = { ...current, ...patch }
      fake.records.set(id, next)
      return next
    },
    removeRavel: (id) => {
      fake.records.delete(id)
    },
    runVerify: async (script, hookCtx) => {
      fake.verifies.push({ script, ...hookCtx })
      return verifyOutcome(script)
    }
  })

  return fake
}

/**
 * Tool dispatch runs on the runtime's promise queue and every injected fake
 * resolves immediately, so draining microtasks is enough — no wall-clock waits.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 200; i += 1) await Promise.resolve()
}

function planProposal(sourceMessageIds: string[]): Record<string, unknown> {
  return {
    tool: 'propose_plan',
    sourceMessageIds,
    mission: {
      goal: 'Fix the auth refresh drop',
      context: [MISSION_CONTEXT],
      constraints: ['Do not touch billing'],
      acceptanceCriteria: ['Refresh keeps the session alive'],
      assumptions: []
    },
    briefs: [
      {
        id: 'brief-1',
        title: 'Repair refresh handling',
        role: 'lead-engineer',
        harness: 'codex',
        model: 'gpt-fake-1',
        phase: 'implementation',
        goal: 'Repair the refresh path',
        relevantContext: ['src/main/auth.ts'],
        constraints: ['Do not touch renderer'],
        acceptanceCriteria: ['Tests pass'],
        doNotTouch: ['src/renderer/**'],
        expectedOutput: 'Patch plus test output',
        escalationConditions: ['Schema mismatch'],
        dependsOn: [],
        contextExceptionReason: null
      }
    ]
  }
}

/** Adds an auditor that depends on brief-1, to exercise the handoff path. */
function planWithDependency(sourceMessageIds: string[]): Record<string, unknown> {
  const base = planProposal(sourceMessageIds)
  const briefs = base.briefs as Record<string, unknown>[]
  return {
    ...base,
    briefs: [
      ...briefs,
      {
        id: 'brief-2',
        title: 'Audit the refresh fix',
        role: 'auditor',
        harness: 'claude',
        model: null,
        phase: 'after-implementation',
        goal: 'Review the refresh change',
        relevantContext: ['src/main/auth.ts'],
        constraints: ['Report only'],
        acceptanceCriteria: ['Findings ranked by severity'],
        doNotTouch: ['**'],
        expectedOutput: 'Ranked findings',
        escalationConditions: ['Missing tests'],
        dependsOn: ['brief-1'],
        contextExceptionReason: null
      }
    ]
  }
}

/** Two briefs that depend on nothing, so both children run — and finish — at once. */
function twoBriefPlan(sourceMessageIds: string[]): Record<string, unknown> {
  const dependent = planWithDependency(sourceMessageIds)
  const briefs = (dependent.briefs as Record<string, unknown>[]).map((brief) =>
    brief.id === 'brief-2' ? { ...brief, dependsOn: [], phase: 'implementation' } : brief
  )
  return { ...dependent, briefs }
}

function nineIndependentBriefPlan(sourceMessageIds: string[]): Record<string, unknown> {
  const base = planProposal(sourceMessageIds)
  const template = (base.briefs as Record<string, unknown>[])[0]
  const roles = ['lead-engineer', 'auditor', 'minor-task', 'researcher', 'test-engineer', 'security-engineer', 'performance-engineer', 'release-engineer', 'minor-task']
  return {
    ...base,
    briefs: roles.map((role, index) => ({
      ...template,
      id: `brief-${index + 1}`,
      title: `Independent task ${index + 1}`,
      role,
      goal: `Complete independent task ${index + 1}`,
      dependsOn: []
    }))
  }
}
/** N independent briefs cycling the specialist vocabulary; used for queue/drain coverage. */
function independentBriefPlan(sourceMessageIds: string[], count: number): Record<string, unknown> {
  const base = planProposal(sourceMessageIds)
  const template = (base.briefs as Record<string, unknown>[])[0]
  const roles = ['lead-engineer', 'auditor', 'minor-task', 'researcher', 'test-engineer', 'security-engineer', 'performance-engineer', 'release-engineer']
  return {
    ...base,
    briefs: Array.from({ length: count }, (_, index) => ({
      ...template,
      id: `brief-${index + 1}`,
      title: `Independent task ${index + 1}`,
      role: roles[index % roles.length],
      goal: `Complete independent task ${index + 1}`,
      dependsOn: []
    }))
  }
}

let activeRavelId: string | null = null

afterEach(async () => {
  if (activeRavelId) {
    await deleteRavel(activeRavelId)
    activeRavelId = null
  }
  setRavelRuntimeServicesForTest(null)
  setInternalChildCapacityForTest(null)
  setInsightNotifier(() => {})
  settingsOverride = null
  worktreeBase = DEFAULT_WORKTREE_BASE
  verifyOutcome = () => ({ ok: true, exitCode: 0, stdout: 'ok', stderr: '', ranWith: 'fake' })
  onCreateWorktree = null
  failNextWorktree = false
})

describe('Ravel runtime integration (no quota spend)', () => {
  test('clarify, propose, approve, and dispatch a scoped child without leaking full context', async () => {
    const fake = harness()
    fake.script.push(withAnsi(toolBlock({ tool: 'ask_clarification', question: 'Which branch should I target?' })))

    const created = await createRavel(
      {
        name: 'Ravel test',
        repoId: 'repo-1',
        repoPath: 'C:/repo',
        harness: 'claude',
        initialInstruction: 'Auth drops after refresh',
        maxChildren: 4,
        // Opt in to auto-approve so the child dispatch below carries it (default is off).
        allowRisky: true
      },
      SETTINGS
    )

    expect(created.ok).toBe(true)
    if (!created.ok) throw new Error('expected create to succeed')
    activeRavelId = created.ravel.id
    expect('capSecret' in created.ravel).toBe(false)

    // 1. No manager session exists at all; the turn is a headless invocation.
    expect(fake.created).toHaveLength(0)
    expect(created.ravel.managerSessionId).toBeNull()
    expect(fake.prompts).toHaveLength(1)
    expect(fake.prompts[0]).toContain('Auth drops after refresh')

    // 2. Clarification blocks planning until the user answers.
    expect(getRavel(created.ravel.id)?.activity).toBe('needs-clarification')

    // 3. A spawn before any plan is refused for the right reason, not silently.
    fake.script.push(toolBlock({ tool: 'spawn_child', briefId: 'brief-1' }))
    const answered = await sendMessage(created.ravel.id, USER_SECRET_ASK, SETTINGS)
    if (!answered?.ok) throw new Error('expected message delivery')
    expect(answered.ravel.messages.some((message) => message.body === USER_SECRET_ASK)).toBe(true)
    expect(answered.ravel.messages.every((message) => message.delivery === 'delivered')).toBe(true)
    expect(fake.worktrees).toHaveLength(0)
    // The refusal is fed back into the follow-up invocation of the same event.
    expect(fake.prompts[fake.prompts.length - 1]).toContain('ravel-not-running')

    // 4. Proposal parks the fleet at the approval gate.
    const answerId = answered.ravel.messages[answered.ravel.messages.length - 1].id
    fake.script.length = 0
    fake.script.push(toolBlock(planProposal([answerId])))
    const proposedResult = await sendMessage(created.ravel.id, 'Go ahead and plan it', SETTINGS)
    if (!proposedResult?.ok) throw new Error('expected message delivery')
    expect(getRavel(created.ravel.id)?.status).toBe('awaiting-approval')
    const proposed = getRavel(created.ravel.id) as PublicRavelConfig
    expect(proposed.plan?.revision).toBe(1)
    expect(proposed.plan?.approvedRevision).toBeNull()

    // 5. Approval is the event that dispatches; one child, scoped.
    fake.script.push(toolBlock({ tool: 'spawn_child', briefId: 'brief-1' }))
    const approved = await approvePlan(created.ravel.id, 1, SETTINGS)
    if (!approved?.ok) throw new Error('expected approval to succeed')
    expect(approved.ravel.status).toBe('running')
    expect(approved.ravel.plan?.approvedRevision).toBe(1)
    expect('capSecret' in approved.ravel).toBe(false)

    const childRequest = fake.created[0]
    expect(childRequest.kind).toBe('ravel-child')
    expect(childRequest.ravelRole).toBe('lead-engineer')
    expect(childRequest.briefId).toBe('brief-1')
    expect(childRequest.harness).toBe('codex')
    expect(childRequest.model).toBe('gpt-fake-1')
    // autoApprove mirrors the Ravel's allowRisky (opted in above); default would be false.
    expect(childRequest.autoApprove).toBe(true)
    expect(childRequest.env).toBeUndefined()
    expect(fake.worktrees).toEqual([childRequest.worktreePath])

    const childPrompt = childRequest.initialPrompt ?? ''
    expect(childPrompt).toContain('ROLE: Lead Engineer')
    expect(childPrompt).toContain('Repair the refresh path')
    expect(childPrompt).toContain('DO NOT TOUCH')
    expect(childPrompt).not.toContain(MISSION_CONTEXT)
    expect(childPrompt).not.toContain(USER_SECRET_ASK)
    expect(childPrompt).not.toContain('Fix the auth refresh drop')

    const dispatched = getRavel(created.ravel.id) as PublicRavelConfig
    expect(dispatched.dispatches).toHaveLength(1)
    expect(dispatched.dispatches[0]).toMatchObject({ briefId: 'brief-1', planRevision: 1, status: 'active' })
    expect(getLog(created.ravel.id).some((entry) => entry.event === 'spawn' && entry.level === 'action')).toBe(true)
  })

  test('queues excess independent briefs and drains the queue as capacity returns', async () => {
    const fake = harness()
    // Pin the adaptive capacity so the queue/drain assertions are exact on any host.
    setInternalChildCapacityForTest(8)

    const created = await createRavel(
      {
        name: 'Queue test',
        repoId: 'repo-1',
        repoPath: 'C:/repo',
        harness: 'claude',
        allowRisky: true
      },
      SETTINGS
    )
    if (!created.ok) throw new Error('expected create to succeed')
    activeRavelId = created.ravel.id

    const instruction = await sendMessage(created.ravel.id, 'Run nine independent tasks', SETTINGS)
    if (!instruction?.ok) throw new Error('expected instruction delivery')
    const sourceId = instruction.ravel.messages[instruction.ravel.messages.length - 1].id
    fake.script.push(toolBlock(nineIndependentBriefPlan([sourceId])))
    const proposed = await sendMessage(created.ravel.id, 'Propose the nine-task plan', SETTINGS)
    if (!proposed?.ok) throw new Error('expected proposal delivery')
    expect(proposed.ravel.status).toBe('awaiting-approval')

    fake.script.push(
      Array.from({ length: 9 }, (_, index) => toolBlock({ tool: 'spawn_child', briefId: `brief-${index + 1}` })).join('') +
      toolBlock({ tool: 'reply', body: 'All independent tasks are queued or running.' })
    )
    const approved = await approvePlan(created.ravel.id, 1, SETTINGS)
    if (!approved?.ok) throw new Error('expected approval to succeed')
    await settle()

    expect(fake.created).toHaveLength(8)
    expect(getLog(created.ravel.id).some((entry) => entry.event === 'spawn-queued')).toBe(true)

    fake.script.push(toolBlock({ tool: 'reply', body: 'One slot is available.' }))
    onSessionExit(fake.sessions[0].id, { exitCode: 0, outputChars: 128, tail: 'done' })
    await settle()

    expect(fake.created).toHaveLength(9)
    expect(getRavel(created.ravel.id)?.dispatches.some((dispatch) => dispatch.briefId === 'brief-9')).toBe(true)
  })

  test('a nameless create normalizes to Reigen and queues above capacity', async () => {
    // Capacity 2 with three independent briefs: two run, one queues.
    const fake = harness()
    setInternalChildCapacityForTest(2)

    const created = await createRavel(
      { repoId: 'repo-1', repoPath: 'C:/repo', harness: 'claude', allowRisky: true },
      SETTINGS
    )
    if (!created.ok) throw new Error('expected create to succeed')
    expect(created.ravel.name).toBe('Reigen')
    activeRavelId = created.ravel.id
    const id = created.ravel.id

    const instruction = await sendMessage(id, 'Run three independent tasks', SETTINGS)
    if (!instruction?.ok) throw new Error('expected instruction delivery')
    const sourceId = instruction.ravel.messages[instruction.ravel.messages.length - 1].id
    fake.script.push(toolBlock(independentBriefPlan([sourceId], 3)))
    await sendMessage(id, 'Propose the three-task plan', SETTINGS)

    fake.script.push(
      Array.from({ length: 3 }, (_, index) => toolBlock({ tool: 'spawn_child', briefId: `brief-${index + 1}` })).join('') +
      toolBlock({ tool: 'reply', body: 'Two running, one queued.' })
    )
    await approvePlan(id, 1, SETTINGS)
    await settle()

    expect(fake.created).toHaveLength(2)
    expect(fake.created.map((req) => req.briefId).sort()).toEqual(['brief-1', 'brief-2'])
    expect(getLog(id).some((entry) => entry.event === 'spawn-queued')).toBe(true)
  })

  test('detaching a live child frees its slot and drains the next queued brief', async () => {
    const fake = harness()
    setInternalChildCapacityForTest(2)

    const created = await createRavel(
      { repoId: 'repo-1', repoPath: 'C:/repo', harness: 'claude', allowRisky: true },
      SETTINGS
    )
    if (!created.ok) throw new Error('expected create to succeed')
    activeRavelId = created.ravel.id
    const id = created.ravel.id

    const instruction = await sendMessage(id, 'Run three independent tasks', SETTINGS)
    if (!instruction?.ok) throw new Error('expected instruction delivery')
    const sourceId = instruction.ravel.messages[instruction.ravel.messages.length - 1].id
    fake.script.push(toolBlock(independentBriefPlan([sourceId], 3)))
    await sendMessage(id, 'Propose the three-task plan', SETTINGS)

    fake.script.push(
      Array.from({ length: 3 }, (_, index) => toolBlock({ tool: 'spawn_child', briefId: `brief-${index + 1}` })).join('') +
      toolBlock({ tool: 'reply', body: 'Two running, one queued.' })
    )
    await approvePlan(id, 1, SETTINGS)
    await settle()
    expect(fake.created).toHaveLength(2)

    // Detach (cancel) a live child: its slot reopens and brief-3 advances after the replan turn.
    fake.script.push(toolBlock({ tool: 'reply', body: 'Replanning around the gap.' }))
    await detachChild(id, fake.sessions[0].id, SETTINGS)
    await settle()

    expect(fake.created).toHaveLength(3)
    expect(fake.created[2].briefId).toBe('brief-3')
    expect(getRavel(id)?.dispatches.some((dispatch) => dispatch.briefId === 'brief-3' && dispatch.status === 'active')).toBe(true)
  })

  test('a queued brief drains when the ravel resumes after a pause', async () => {
    const fake = harness()
    setInternalChildCapacityForTest(2)

    const created = await createRavel(
      { repoId: 'repo-1', repoPath: 'C:/repo', harness: 'claude', allowRisky: true },
      SETTINGS
    )
    if (!created.ok) throw new Error('expected create to succeed')
    activeRavelId = created.ravel.id
    const id = created.ravel.id

    const instruction = await sendMessage(id, 'Run three independent tasks', SETTINGS)
    if (!instruction?.ok) throw new Error('expected instruction delivery')
    const sourceId = instruction.ravel.messages[instruction.ravel.messages.length - 1].id
    fake.script.push(toolBlock(independentBriefPlan([sourceId], 3)))
    await sendMessage(id, 'Propose the three-task plan', SETTINGS)

    fake.script.push(
      Array.from({ length: 3 }, (_, index) => toolBlock({ tool: 'spawn_child', briefId: `brief-${index + 1}` })).join('') +
      toolBlock({ tool: 'reply', body: 'Two running, one queued.' })
    )
    await approvePlan(id, 1, SETTINGS)
    await settle()
    expect(fake.created).toHaveLength(2)
    expect(getLog(id).some((entry) => entry.event === 'spawn-queued')).toBe(true)

    // Pausing interrupts both live children, reopening capacity; brief-3 stays queued.
    pauseRavel(id)
    await settle()
    expect(getRavel(id)?.status).toBe('paused')
    expect(getRavel(id)?.dispatches.filter((dispatch) => dispatch.status === 'interrupted')).toHaveLength(2)

    // Resume runs the manager turn and then drains the stranded brief into a freed slot.
    fake.script.push(toolBlock({ tool: 'reply', body: 'Resuming.' }))
    await resumeRavel(id, SETTINGS)
    await settle()

    expect(fake.created).toHaveLength(3)
    expect(fake.created[2].briefId).toBe('brief-3')
  })

  test('a failed start releases capacity and the queue continues with the next brief', async () => {
    const fake = harness()
    setInternalChildCapacityForTest(1)

    const created = await createRavel(
      { repoId: 'repo-1', repoPath: 'C:/repo', harness: 'claude', allowRisky: true },
      SETTINGS
    )
    if (!created.ok) throw new Error('expected create to succeed')
    activeRavelId = created.ravel.id
    const id = created.ravel.id

    const instruction = await sendMessage(id, 'Run three independent tasks', SETTINGS)
    if (!instruction?.ok) throw new Error('expected instruction delivery')
    const sourceId = instruction.ravel.messages[instruction.ravel.messages.length - 1].id
    fake.script.push(toolBlock(independentBriefPlan([sourceId], 3)))
    await sendMessage(id, 'Propose the three-task plan', SETTINGS)

    fake.script.push(
      Array.from({ length: 3 }, (_, index) => toolBlock({ tool: 'spawn_child', briefId: `brief-${index + 1}` })).join('') +
      toolBlock({ tool: 'reply', body: 'One running, two queued.' })
    )
    await approvePlan(id, 1, SETTINGS)
    await settle()
    // Capacity 1: only brief-1 runs; brief-2 and brief-3 wait.
    expect(fake.created).toHaveLength(1)
    expect(getLog(id).some((entry) => entry.event === 'spawn-queued')).toBe(true)

    // The next attempted start fails at worktree creation; the brief after it still launches.
    failNextWorktree = true
    fake.script.push(toolBlock({ tool: 'reply', body: 'Continuing.' }))
    onSessionExit(fake.sessions[0].id, { exitCode: 0, outputChars: 64, tail: 'done' })
    await settle()

    const dispatches = getRavel(id)?.dispatches ?? []
    expect(dispatches.find((dispatch) => dispatch.briefId === 'brief-2')?.status).toBe('failed')
    expect(dispatches.find((dispatch) => dispatch.briefId === 'brief-3')?.status).toBe('active')
    expect(fake.created.map((req) => req.briefId).sort()).toEqual(['brief-1', 'brief-3'])
  })

  test('the manager prompt carries the bounded digest, never the mission or brief bodies', async () => {
    const fake = harness()
    fake.script.push(toolBlock({ tool: 'reply', body: 'Working on it.' }))

    const created = await createRavel(
      { name: 'Ravel bounds', repoId: 'repo-1', repoPath: 'C:/repo', harness: 'claude', maxChildren: 4 },
      SETTINGS
    )
    if (!created.ok) throw new Error('expected create to succeed')
    activeRavelId = created.ravel.id

    fake.script.push(toolBlock(planProposal([])))
    const seeded = await sendMessage(created.ravel.id, 'Fix the refresh drop', SETTINGS)
    if (!seeded?.ok) throw new Error('expected message delivery')
    fake.script.push(toolBlock(planProposal([seeded.ravel.messages[0].id])))
    await sendMessage(created.ravel.id, 'Plan it now', SETTINGS)

    fake.script.push(toolBlock({ tool: 'get_status' }), toolBlock({ tool: 'reply', body: 'All quiet.' }))
    await approvePlan(created.ravel.id, 1, SETTINGS)

    const last = fake.prompts[fake.prompts.length - 1]
    expect(last).toContain('brief-1')
    expect(last).toContain('Repair refresh handling')
    // Brief bodies and the mission belong to the plan record, not to every turn.
    expect(last).not.toContain('Repair the refresh path')
    expect(last).not.toContain(MISSION_CONTEXT)
    expect(last).not.toContain('Patch plus test output')
    expect(last.length).toBeLessThanOrEqual(12_000)
  })

  test('a second dispatch of the same brief is refused, keeping one child per approved brief', async () => {
    const fake = harness()
    fake.script.push(toolBlock(planProposal([])))

    const created = await createRavel(
      {
        name: 'Ravel guard',
        repoId: 'repo-1',
        repoPath: 'C:/repo',
        harness: 'claude',
        initialInstruction: 'Fix the refresh drop',
        maxChildren: 4
      },
      SETTINGS
    )
    if (!created.ok) throw new Error('expected create to succeed')
    activeRavelId = created.ravel.id

    fake.script.length = 0
    fake.script.push(toolBlock(planProposal([created.ravel.messages[0].id])))
    await sendMessage(created.ravel.id, 'Plan it now', SETTINGS)
    expect(getRavel(created.ravel.id)?.status).toBe('awaiting-approval')

    // One event, two spawn calls for the same brief: the second must be refused.
    fake.script.length = 0
    fake.script.push(
      toolBlock({ tool: 'spawn_child', briefId: 'brief-1' }) + toolBlock({ tool: 'spawn_child', briefId: 'brief-1' }),
      toolBlock({ tool: 'reply', body: 'One child is enough.' })
    )
    const approved = await approvePlan(created.ravel.id, 1, SETTINGS)
    if (!approved?.ok) throw new Error('expected approval to succeed')

    expect(fake.created).toHaveLength(1)
    expect(fake.worktrees).toHaveLength(1)
    expect(getRavel(created.ravel.id)?.dispatches).toHaveLength(1)
    expect(fake.prompts[fake.prompts.length - 1]).toContain('brief-already-live')
  })

  test('a manager harness that runs dry is re-pointed to the next vendor mid-run', async () => {
    const fake = harness()
    // The first (claude) turn hits a quota wall; the re-pointed (codex) turn replies.
    fake.throwOnce.set('claude', 'Claude headless turn exited 1: You have exceeded your quota')
    fake.script.push(toolBlock({ tool: 'reply', body: 'Picking this up on the backup.' }))

    const created = await createRavel(
      { name: 'Ravel dry', repoId: 'repo-1', repoPath: 'C:/repo', harness: 'claude', initialInstruction: 'Fix it' },
      SETTINGS
    )
    if (!created.ok) throw new Error('expected create to succeed')

    const cfg = getRavel(created.ravel.id) as PublicRavelConfig
    // Sticky re-point: the manager now runs on codex, with the model cleared so
    // the new vendor uses its own default.
    expect(cfg.harness).toBe('codex')
    expect(cfg.model).toBeNull()
    // The turn SUCCEEDED via fallback - idle with no error, not a failed turn.
    expect(cfg.activity).toBe('idle')
    expect(cfg.error).toBeNull()
    expect(cfg.messages.some((m) => m.body === 'Picking this up on the backup.')).toBe(true)
    expect(getLog(created.ravel.id).some((e) => e.event === 'fallback' && e.level === 'warn')).toBe(true)
  })

  test('a genuine task failure is NOT re-pointed - fallback is only for a dry vendor', async () => {
    const fake = harness()
    fake.throwOnce.set('claude', 'Claude headless turn exited 2: SyntaxError in tool block')

    const created = await createRavel(
      { name: 'Ravel real fail', repoId: 'repo-1', repoPath: 'C:/repo', harness: 'claude', initialInstruction: 'Fix it' },
      SETTINGS
    )
    if (!created.ok) throw new Error('expected create to succeed')

    const cfg = getRavel(created.ravel.id) as PublicRavelConfig
    expect(cfg.harness).toBe('claude') // stayed put
    expect(cfg.error).toContain('SyntaxError')
    expect(getLog(created.ravel.id).some((e) => e.event === 'fallback')).toBe(false)
  })

  test('an idle fleet costs nothing: no timers, and no invocation without an event', async () => {
    vi.useFakeTimers()
    try {
      const fake = harness()
      const created = await createRavel(
        { name: 'Ravel idle', repoId: 'repo-1', repoPath: 'C:/repo', harness: 'claude', maxChildren: 4 },
        SETTINGS
      )
      if (!created.ok) throw new Error('expected create to succeed')
      activeRavelId = created.ravel.id

      expect(fake.prompts).toHaveLength(0)
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
      await settle()
      expect(fake.prompts).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  test('a child exiting drives the next turn, and a paused Ravel does not', async () => {
    const fake = harness()
    fake.script.push(toolBlock(planProposal([])))

    const created = await createRavel(
      {
        name: 'Ravel events',
        repoId: 'repo-1',
        repoPath: 'C:/repo',
        harness: 'claude',
        initialInstruction: 'Fix the refresh drop',
        maxChildren: 4
      },
      SETTINGS
    )
    if (!created.ok) throw new Error('expected create to succeed')
    activeRavelId = created.ravel.id

    fake.script.length = 0
    fake.script.push(toolBlock(planProposal([created.ravel.messages[0].id])))
    await sendMessage(created.ravel.id, 'Plan it now', SETTINGS)

    fake.script.push(toolBlock({ tool: 'spawn_child', briefId: 'brief-1' }))
    await approvePlan(created.ravel.id, 1, SETTINGS)
    const child = fake.sessions[0]

    const beforeExit = fake.prompts.length
    fake.script.push(toolBlock({ tool: 'complete', summary: 'Refresh fixed.' }))
    fake.sessions = fake.sessions.map((session) =>
      session.id === child.id ? { ...session, status: 'closed' as const } : session
    )
    onSessionExit(child.id, { exitCode: 0, outputChars: 512, tail: '' })
    await settle()

    expect(fake.prompts.length).toBe(beforeExit + 1)
    expect(fake.prompts[fake.prompts.length - 1]).toContain('brief-1 completed')
    expect(getRavel(created.ravel.id)?.status).toBe('completed')

    // Paused: a further exit event must not buy another manager turn.
    pauseRavel(created.ravel.id)
    const afterComplete = fake.prompts.length
    onSessionExit(child.id, { exitCode: 0, outputChars: 0, tail: '' })
    await settle()
    expect(fake.prompts).toHaveLength(afterComplete)
  })

  test('detach promotes a live child to a standalone session and asks the manager to replan', async () => {
    const fake = harness()
    fake.script.push(toolBlock(planProposal([])))

    const created = await createRavel(
      { name: 'Ravel detach', repoId: 'repo-1', repoPath: 'C:/repo', harness: 'claude', initialInstruction: 'Fix it', maxChildren: 4 },
      SETTINGS
    )
    if (!created.ok) throw new Error('expected create to succeed')
    activeRavelId = created.ravel.id
    const id = created.ravel.id

    fake.script.length = 0
    fake.script.push(toolBlock(planProposal([created.ravel.messages[0].id])))
    await sendMessage(id, 'Plan it now', SETTINGS)
    fake.script.push(toolBlock({ tool: 'spawn_child', briefId: 'brief-1' }))
    await approvePlan(id, 1, SETTINGS)
    const child = fake.sessions[0]
    // Default Ravel (allowRisky off) must NOT auto-approve its children.
    expect(fake.created[0].autoApprove).toBe(false)

    // A live dispatch cannot be archived — it must be stopped or detached first.
    expect(() => archiveDispatch(id, child.id)).toThrow(/still live/)

    // The detach fires a replan manager turn; script a reply so the turn resolves.
    fake.script.push(toolBlock({ tool: 'reply', body: 'Noted; will replan.' }))
    const promptsBefore = fake.prompts.length
    const detached = await detachChild(id, child.id, SETTINGS)
    expect(detached).toBeDefined()
    await settle()

    // Dispatch is terminal `detached`, ended, and the ravel released its session id.
    const record = getRavel(id)?.dispatches.find((d) => d.briefId === 'brief-1')
    expect(record?.status).toBe('detached')
    expect(record?.endedAt).not.toBeNull()
    expect(record?.sessionId).toBeNull()
    // The child was PROMOTED to a standalone normal session, not killed.
    expect(fake.killed).not.toContain(child.id)
    expect(fake.sessions.find((s) => s.id === child.id)?.kind).toBe('normal')
    // The manager received an explicit replan event.
    expect(fake.prompts.length).toBeGreaterThan(promptsBefore)
    expect(fake.prompts[fake.prompts.length - 1]).toContain('detached')
    expect(getLog(id).some((e) => e.event === 'detach')).toBe(true)
  })

  test('archive hides a terminal dispatch from the public fleet projection', async () => {
    const fake = harness()
    fake.script.push(toolBlock(planProposal([])))

    const created = await createRavel(
      { name: 'Ravel archive', repoId: 'repo-1', repoPath: 'C:/repo', harness: 'claude', initialInstruction: 'Fix it', maxChildren: 4 },
      SETTINGS
    )
    if (!created.ok) throw new Error('expected create to succeed')
    activeRavelId = created.ravel.id
    const id = created.ravel.id

    fake.script.length = 0
    fake.script.push(toolBlock(planProposal([created.ravel.messages[0].id])))
    await sendMessage(id, 'Plan it now', SETTINGS)
    fake.script.push(toolBlock({ tool: 'spawn_child', briefId: 'brief-1' }))
    await approvePlan(id, 1, SETTINGS)
    const child = fake.sessions[0]

    // Drive the child to a terminal (completed) dispatch.
    fake.script.push(toolBlock({ tool: 'complete', summary: 'Done.' }))
    fake.sessions = fake.sessions.map((s) => (s.id === child.id ? { ...s, status: 'closed' as const } : s))
    onSessionExit(child.id, { exitCode: 0, outputChars: 64, tail: '' })
    await settle()
    expect(getRavel(id)?.dispatches.find((d) => d.sessionId === child.id)?.status).toBe('completed')

    const archived = archiveDispatch(id, child.id)
    expect(archived?.dispatches.find((d) => d.sessionId === child.id)).toBeUndefined()
    // The public projection no longer surfaces the archived dispatch.
    expect(getRavel(id)?.dispatches.find((d) => d.sessionId === child.id)).toBeUndefined()
    expect(getLog(id).some((e) => e.event === 'archive')).toBe(true)
  })
})

describe('Ravel token economy (no quota spend)', () => {
  test('a manager turn accrues estimated usage and logs it', async () => {
    const fake = harness()
    fake.script.push(toolBlock({ tool: 'reply', body: 'Working on it.' }))

    const created = await createRavel(
      { name: 'Ravel meter', repoId: 'repo-1', repoPath: 'C:/repo', harness: 'claude', model: 'opus', initialInstruction: 'Do the thing' },
      SETTINGS
    )
    if (!created.ok) throw new Error('expected create to succeed')
    activeRavelId = created.ravel.id

    const metered = getRavel(created.ravel.id) as PublicRavelConfig
    expect(metered.usage.inputTokens).toBeGreaterThan(0)
    expect(metered.usage.outputTokens).toBeGreaterThan(0)
    // 'opus' is in the rate table, so a cost is derivable rather than unknown.
    expect(metered.usage.costUsd).toBeGreaterThan(0)

    const turnLog = getLog(created.ravel.id).find((entry) => entry.event === 'turn')
    expect(turnLog?.text).toContain('tok (est.)')
    expect(turnLog?.text).toMatch(/~\d+ in \/ ~\d+ out tok \(est\.\)/)
  })

  test('crossing the ceiling pauses the ravel and refuses the next turn', async () => {
    const fake = harness()
    const tight: Settings = { ...SETTINGS, tokenCeilingPerRavel: 100 }
    fake.script.push(toolBlock({ tool: 'reply', body: 'Working on it.' }))

    const created = await createRavel(
      { name: 'Ravel budget', repoId: 'repo-1', repoPath: 'C:/repo', harness: 'claude', initialInstruction: 'Do the thing' },
      tight
    )
    if (!created.ok) throw new Error('expected create to succeed')
    activeRavelId = created.ravel.id

    // The turn that crosses the ceiling still completes and is recorded.
    const spent = (getRavel(created.ravel.id) as PublicRavelConfig).usage
    expect(spent.inputTokens + spent.outputTokens).toBeGreaterThanOrEqual(100)
    expect(getRavel(created.ravel.id)?.status).not.toBe('paused')

    const turnsBefore = fake.prompts.length
    fake.script.push(toolBlock({ tool: 'reply', body: 'Still going.' }))
    await sendMessage(created.ravel.id, 'keep going', tight)
    await settle()

    const paused = getRavel(created.ravel.id) as PublicRavelConfig
    expect(paused.status).toBe('paused')
    expect(paused.error).toContain('token ceiling')
    expect(fake.prompts).toHaveLength(turnsBefore)
    expect(getLog(created.ravel.id).some((entry) => entry.event === 'budget' && entry.level === 'warn')).toBe(true)
  })

  test('the ceiling refuses a spawn before any worktree is created', async () => {
    const fake = harness()
    fake.script.push(toolBlock(planProposal([])))

    const created = await createRavel(
      { name: 'Ravel spawn budget', repoId: 'repo-1', repoPath: 'C:/repo', harness: 'claude', initialInstruction: 'Plan it' },
      SETTINGS
    )
    if (!created.ok) throw new Error('expected create to succeed')
    activeRavelId = created.ravel.id

    fake.script.length = 0
    fake.script.push(toolBlock(planProposal([created.ravel.messages[0].id])))
    await sendMessage(created.ravel.id, 'Plan it now', SETTINGS)
    expect(getRavel(created.ravel.id)?.status).toBe('awaiting-approval')

    // The entrypoint settings keep the turn loop open; what the runtime reads
    // for itself carries the ceiling, isolating the spawn guard.
    settingsOverride = { ...SETTINGS, tokenCeilingPerRavel: 100 }
    fake.script.push(toolBlock({ tool: 'spawn_child', briefId: 'brief-1' }))
    await approvePlan(created.ravel.id, 1, SETTINGS)
    await settle()

    expect(fake.worktrees).toHaveLength(0)
    expect(fake.created).toHaveLength(0)
    expect(getRavel(created.ravel.id)?.status).toBe('paused')
  })

  test("a completed child's report reaches the manager and its usage lands on the dispatch", async () => {
    const fake = harness()
    worktreeBase = mkdtempSync(join(tmpdir(), 'ravel-report-')).replace(/\\/g, '/')
    fake.script.push(toolBlock(planProposal([])))

    const created = await createRavel(
      { name: 'Ravel report', repoId: 'repo-1', repoPath: 'C:/repo', harness: 'claude', initialInstruction: 'Plan it' },
      SETTINGS
    )
    if (!created.ok) throw new Error('expected create to succeed')
    activeRavelId = created.ravel.id

    fake.script.length = 0
    fake.script.push(toolBlock(planProposal([created.ravel.messages[0].id])))
    await sendMessage(created.ravel.id, 'Plan it now', SETTINGS)

    fake.script.push(toolBlock({ tool: 'spawn_child', briefId: 'brief-1' }))
    await approvePlan(created.ravel.id, 1, SETTINGS)
    const child = fake.sessions[0]
    const worktreePath = fake.created[0].worktreePath

    // The child is instructed to publish exactly this file.
    expect(fake.created[0].initialPrompt).toContain('.conductor/report.md')
    mkdirSync(join(worktreePath, '.conductor'), { recursive: true })
    writeFileSync(join(worktreePath, '.conductor', 'report.md'), 'DUMMY REPORT: touched nothing\n', 'utf8')

    fake.script.push(toolBlock({ tool: 'complete', summary: 'Done.' }))
    onSessionExit(child.id, { exitCode: 0, outputChars: 4_000, tail: '' })
    await settle()

    const done = getRavel(created.ravel.id) as PublicRavelConfig
    expect(done.dispatches[0].status).toBe('completed')
    expect(done.dispatches[0].report).toBe('DUMMY REPORT: touched nothing')
    expect(done.dispatches[0].usage.inputTokens).toBeGreaterThan(0)
    expect(done.dispatches[0].usage.outputTokens).toBe(1_000)
    expect(fake.prompts[fake.prompts.length - 1]).toContain('DUMMY REPORT: touched nothing')
  })

  test('a non-zero exit fails the dispatch even though the session record is gone', async () => {
    const fake = harness()
    fake.script.push(toolBlock(planProposal([])))

    const created = await createRavel(
      { name: 'Ravel exit code', repoId: 'repo-1', repoPath: 'C:/repo', harness: 'claude', initialInstruction: 'Plan it' },
      SETTINGS
    )
    if (!created.ok) throw new Error('expected create to succeed')
    activeRavelId = created.ravel.id

    fake.script.length = 0
    fake.script.push(toolBlock(planProposal([created.ravel.messages[0].id])))
    await sendMessage(created.ravel.id, 'Plan it now', SETTINGS)

    fake.script.push(toolBlock({ tool: 'spawn_child', briefId: 'brief-1' }))
    await approvePlan(created.ravel.id, 1, SETTINGS)
    const child = fake.sessions[0]

    // sessions.ts deletes the runtime at exit, so success must come from the code.
    fake.sessions = fake.sessions.filter((session) => session.id !== child.id)
    fake.script.push(toolBlock({ tool: 'reply', body: 'Noted.' }))
    onSessionExit(child.id, { exitCode: 1, outputChars: 100, tail: '' })
    await settle()

    expect((getRavel(created.ravel.id) as PublicRavelConfig).dispatches[0].status).toBe('failed')
  })
})

describe('Ravel resume metering (no quota spend)', () => {
  /** Pausing while the worktree is being built is what leaves a dispatch interrupted. */
  async function interruptedRavel(fake) {
    fake.script.push(toolBlock(planProposal([])))
    const created = await createRavel(
      { name: 'Ravel resume', repoId: 'repo-1', repoPath: 'C:/repo', harness: 'claude', initialInstruction: 'Plan it' },
      SETTINGS
    )
    if (!created.ok) throw new Error('expected create to succeed')
    activeRavelId = created.ravel.id

    fake.script.length = 0
    fake.script.push(toolBlock(planProposal([created.ravel.messages[0].id])))
    await sendMessage(created.ravel.id, 'Plan it now', SETTINGS)

    onCreateWorktree = () => pauseRavel(created.ravel.id)
    fake.script.push(toolBlock({ tool: 'spawn_child', briefId: 'brief-1' }))
    await approvePlan(created.ravel.id, 1, SETTINGS)
    await settle()
    onCreateWorktree = null

    const cfg = getRavel(created.ravel.id) as PublicRavelConfig
    expect(cfg.dispatches[0].status).toBe('interrupted')
    return created.ravel.id
  }

  test('resuming an interrupted brief bills its second prompt', async () => {
    const fake = harness()
    const id = await interruptedRavel(fake)

    fake.script.push(toolBlock({ tool: 'reply', body: 'Picking back up.' }))
    await resumeRavel(id, SETTINGS)
    await settle()

    const before = getRavel(id) as PublicRavelConfig
    const dispatchBefore = before.dispatches[0].usage.inputTokens
    const createdBefore = fake.created.length

    const resumed = await resumeInterruptedBrief(id, 1, 'brief-1', SETTINGS)
    expect(resumed?.ok).toBe(true)
    await settle()

    const after = getRavel(id) as PublicRavelConfig
    expect(fake.created).toHaveLength(createdBefore + 1)
    // A second launch means a second prompt; billing only the first would let a
    // brief be relaunched indefinitely for free.
    expect(after.dispatches[0].usage.inputTokens).toBeGreaterThan(dispatchBefore)
    expect(after.usage.inputTokens).toBeGreaterThan(before.usage.inputTokens)
  })

  test('the ceiling refuses a resume and pauses, launching nothing', async () => {
    const fake = harness()
    const id = await interruptedRavel(fake)

    fake.script.push(toolBlock({ tool: 'reply', body: 'Picking back up.' }))
    await resumeRavel(id, SETTINGS)
    await settle()

    const createdBefore = fake.created.length
    settingsOverride = { ...SETTINGS, tokenCeilingPerRavel: 100 }
    const refused = await resumeInterruptedBrief(id, 1, 'brief-1', SETTINGS)

    expect(refused).toMatchObject({ ok: false, error: { code: 'token-ceiling' } })
    expect(fake.created).toHaveLength(createdBefore)
    expect(getRavel(id)?.status).toBe('paused')
  })
})

describe('Ravel live child metering (no quota spend)', () => {
  /** Drives a ravel to the point where exactly one child is active. */
  async function ravelWithActiveChild(fake, name) {
    fake.script.push(toolBlock(planProposal([])))
    const created = await createRavel(
      { name, repoId: 'repo-1', repoPath: 'C:/repo', harness: 'claude', initialInstruction: 'Plan it' },
      SETTINGS
    )
    if (!created.ok) throw new Error('expected create to succeed')
    activeRavelId = created.ravel.id
    fake.script.length = 0
    fake.script.push(toolBlock(planProposal([created.ravel.messages[0].id])))
    await sendMessage(created.ravel.id, 'Plan it now', SETTINGS)
    fake.script.push(toolBlock({ tool: 'spawn_child', briefId: 'brief-1' }))
    await approvePlan(created.ravel.id, 1, SETTINGS)
    await settle()
    return { id: created.ravel.id, child: fake.sessions[0] }
  }

  /** An approved plan with nothing dispatched, so a brief is free to be claimed. */
  async function approvedPlanRavel(fake, name): Promise<string> {
    fake.script.push(toolBlock(planProposal([])))
    const created = await createRavel(
      { name, repoId: 'repo-1', repoPath: 'C:/repo', harness: 'claude', initialInstruction: 'Plan it' },
      SETTINGS
    )
    if (!created.ok) throw new Error('expected create to succeed')
    activeRavelId = created.ravel.id
    fake.script.length = 0
    fake.script.push(toolBlock(planProposal([created.ravel.messages[0].id])))
    await sendMessage(created.ravel.id, 'Plan it now', SETTINGS)
    // Approval without a spawn: the manager replies instead of dispatching.
    fake.script.push(toolBlock({ tool: 'reply', body: 'Ready when you are.' }))
    await approvePlan(created.ravel.id, 1, SETTINGS)
    await settle()
    return created.ravel.id
  }

  test('a live child is billed as it runs, not only when it exits', async () => {
    const fake = harness()
    const { id, child } = await ravelWithActiveChild(fake, 'Ravel live')

    const before = getRavel(id) as PublicRavelConfig
    expect(before.dispatches[0].usage.outputTokens).toBe(0)

    onSessionProgress(child.id, 4_000)

    const during = getRavel(id) as PublicRavelConfig
    expect(during.dispatches[0].usage.outputTokens).toBe(1_000)
    expect(during.usage.outputTokens).toBe(before.usage.outputTokens + 1_000)
    expect(during.dispatches[0].status).toBe('active')
  })

  test('exit reconciles against what was already billed instead of double-charging', async () => {
    const fake = harness()
    const { id, child } = await ravelWithActiveChild(fake, 'Ravel reconcile')

    onSessionProgress(child.id, 4_000)
    // Paused so the child-exit manager turn does not run: its own tokens would
    // mask whether the child was charged twice.
    pauseRavel(id)
    const billed = (getRavel(id) as PublicRavelConfig).usage.outputTokens

    onSessionExit(child.id, { exitCode: 0, outputChars: 4_000, tail: '' })
    await settle()

    const done = getRavel(id) as PublicRavelConfig
    expect(done.dispatches[0].usage.outputTokens).toBe(1_000)
    expect(done.usage.outputTokens).toBe(billed)
  })

  test('a runaway child is killed at the ceiling and left resumable', async () => {
    const fake = harness()
    const { id, child } = await ravelWithActiveChild(fake, 'Ravel runaway')

    settingsOverride = { ...SETTINGS, tokenCeilingPerRavel: 100 }
    onSessionProgress(child.id, 400_000)

    const stopped = getRavel(id) as PublicRavelConfig
    expect(stopped.status).toBe('paused')
    expect(fake.killed).toContain(child.id)
    // Interrupted, never failed: the worktree survives and the brief resumes.
    expect(stopped.dispatches[0].status).toBe('interrupted')
    expect(getLog(id).some((entry) => entry.event === 'budget' && entry.text.includes('stopped 1 live child'))).toBe(true)
  })

  /**
   * A manual pause used to abort only the manager turn. Children kept running and
   * kept billing, while the ceiling check in onSessionProgress is gated on
   * `status === 'running'` — so pausing actively DISABLED the automatic stop and
   * left the fleet spending with no brake at all.
   */

  /**
   * A human seat is a ravel child whose agent is the operator. It must reach the
   * orchestrator through exactly the channels an agent uses, or it is a second
   * protocol pretending to be the first.
   */
  test('claiming a brief opens a shell seat that costs nothing to run', async () => {
    const fake = harness()
    const id = await approvedPlanRavel(fake, 'Ravel seat')

    const claimed = await claimBrief(id, 1, 'brief-1', SETTINGS)
    expect(claimed?.ok).toBe(true)

    const cfg = getRavel(id) as PublicRavelConfig
    const dispatch = cfg.dispatches.find((d) => d.briefId === 'brief-1')
    expect(dispatch?.status).toBe('active')
    // No prompt was sent and no model was chosen, so the seat bills nothing.
    expect(dispatch?.usage.inputTokens).toBe(0)
    expect(dispatch?.usage.outputTokens).toBe(0)
    // The session is a shell, not an agent, and was handed no prompt.
    const seat = fake.sessions.find((session) => session.briefId === 'brief-1')
    expect(seat?.harness).toBeNull()
    const request = fake.created.find((req) => req.briefId === 'brief-1')
    expect(request?.initialPrompt ?? null).toBeNull()
    expect(request?.model ?? null).toBeNull()
  })

  test('the manager cannot be handed a shell: only a claim creates a seat', async () => {
    const fake = harness()
    const id = await approvedPlanRavel(fake, 'Ravel agents only')
    fake.script.push(toolBlock({ tool: 'spawn_child', briefId: 'brief-1' }))
    await sendMessage(id, 'go', SETTINGS)
    await settle()
    const spawned = fake.sessions.find((session) => session.briefId === 'brief-1')
    expect(spawned?.harness).not.toBeNull()
  })

  test('a claimed brief cannot be claimed twice', async () => {
    const fake = harness()
    const id = await approvedPlanRavel(fake, 'Ravel double claim')
    await claimBrief(id, 1, 'brief-1', SETTINGS)
    const again = await claimBrief(id, 1, 'brief-1', SETTINGS)
    expect(again?.ok).toBe(false)
    if (again?.ok === false) expect(again.error.code).toBe('brief-already-live')
  })

  test('a seat finishing drives the next manager turn, exactly as a child exit does', async () => {
    const fake = harness()
    const id = await approvedPlanRavel(fake, 'Ravel seat finish')
    await claimBrief(id, 1, 'brief-1', SETTINGS)
    const seat = fake.sessions.find((session) => session.briefId === 'brief-1')
    if (!seat) throw new Error('expected a seat session')

    const turnsBefore = fake.prompts.length
    fake.script.push(toolBlock({ tool: 'reply', body: 'Noted.' }))
    expect(finishSeat(seat.id, 'Rewired the refresh path by hand.')).toBe(true)
    await settle()

    const cfg = getRavel(id) as PublicRavelConfig
    const dispatch = cfg.dispatches.find((d) => d.briefId === 'brief-1')
    expect(dispatch?.status).toBe('completed')
    expect(dispatch?.endedAt).not.toBeNull()
    expect(dispatch?.report).toContain('Rewired the refresh path')
    // The manager was told, and told the operator's words rather than a transcript.
    expect(fake.prompts.length).toBeGreaterThan(turnsBefore)
    expect(fake.prompts[fake.prompts.length - 1]).toContain('Rewired the refresh path')
  })

  test('finishing an unknown or already-finished seat is refused, not guessed at', async () => {
    expect(finishSeat('no-such-session', 'done')).toBe(false)
    expect(askFromSeat('no-such-session', 'anything')).toBe(false)
  })


  test('a manual pause stops live children, not just the manager', async () => {
    const fake = harness()
    const { id, child } = await ravelWithActiveChild(fake, 'Ravel manual pause')

    expect(fake.killed).not.toContain(child.id)

    pauseRavel(id)

    const paused = getRavel(id) as PublicRavelConfig
    expect(paused.status).toBe('paused')
    expect(fake.killed).toContain(child.id)
    // Interrupted, never failed: the worktree survives and the brief resumes.
    expect(paused.dispatches[0].status).toBe('interrupted')
    expect(getLog(id).some((entry) => entry.event === 'pause' && entry.text.includes('stopped 1 live child'))).toBe(
      true
    )
  })

  test('pausing an idle ravel reports no children and stays quiet about it', async () => {
    const fake = harness()
    fake.script.push(toolBlock({ tool: 'reply', body: 'Nothing to do.' }))
    const created = await createRavel(
      { name: 'Ravel quiet pause', repoId: 'repo-1', repoPath: 'C:/repo', harness: 'claude', initialInstruction: 'Hi' },
      SETTINGS
    )
    if (!created.ok) throw new Error('expected create to succeed')
    activeRavelId = created.ravel.id

    pauseRavel(created.ravel.id)

    expect(fake.killed).toHaveLength(0)
    expect(getLog(created.ravel.id).some((entry) => entry.event === 'pause' && entry.text === 'Ravel paused')).toBe(
      true
    )
  })

  /**
   * The engine and its rules were finished and tested for a session before anything
   * ever called them: nothing constructed the coordinator and no orchestration path
   * fired a trigger, so the mascot could not speak and the renderer threw on boot.
   * These assert the wiring, not the rules.
   */
  test('orchestration fires the triggers the insight engine hangs off', async () => {
    const fake = harness()
    const fired: { trigger: InsightTrigger; ravelId: string }[] = []
    setInsightNotifier((trigger, ravelId) => fired.push({ trigger, ravelId }))

    const { id, child } = await ravelWithActiveChild(fake, 'Ravel insights')
    const seen = (): InsightTrigger[] => [...new Set(fired.map((f) => f.trigger))]

    expect(seen()).toContain('plan-approved')
    expect(seen()).toContain('dispatch-created')
    expect(seen()).toContain('activity-changed')
    expect(fired.every((f) => f.ravelId === id)).toBe(true)

    fake.script.push(toolBlock({ tool: 'complete', summary: 'Done.' }))
    onSessionExit(child.id, { exitCode: 0, outputChars: 100, tail: 'done' })
    await settle()

    expect(seen()).toContain('child-exit')
    expect(seen()).toContain('ravel-completed')
  })

  /**
   * Fires only when a verify command is configured. With none, nothing was verified
   * and nothing landed — so the trigger must stay silent rather than announce a
   * verdict that was never reached.
   */
  test('a landed verdict fires its own trigger, and no verdict fires none', async () => {
    const fake = harness()
    const fired: InsightTrigger[] = []
    const { child } = await ravelWithActiveChild(fake, 'Ravel verdicts')
    setInsightNotifier((trigger) => fired.push(trigger))

    // No verify command configured: nothing was verified, so nothing landed.
    fake.script.push(toolBlock({ tool: 'reply', body: 'Noted.' }))
    onSessionExit(child.id, { exitCode: 0, outputChars: 100, tail: 'done' })
    await settle()
    expect(fired).toContain('child-exit')
    expect(fired).not.toContain('verification-landed')
  })

  test('a configured verify command fires verification-landed once its verdict is in', async () => {
    const fake = harness()
    const fired: InsightTrigger[] = []
    const { child } = await ravelWithActiveChild(fake, 'Ravel verified')
    setInsightNotifier((trigger) => fired.push(trigger))
    settingsOverride = { ...SETTINGS, verify: { global: 'npm test', perRepo: {} } }

    fake.script.push(toolBlock({ tool: 'reply', body: 'Noted.' }))
    onSessionExit(child.id, { exitCode: 0, outputChars: 100, tail: 'done' })
    await settle()

    expect(fake.verifies).toHaveLength(1)
    expect(fired).toContain('verification-landed')
  })

  test('a notifier that throws never breaks the orchestration path that fired it', async () => {
    const fake = harness()
    setInsightNotifier(() => {
      throw new Error('insight exploded')
    })

    const { id, child } = await ravelWithActiveChild(fake, 'Ravel insight blast')
    fake.script.push(toolBlock({ tool: 'complete', summary: 'Done.' }))
    onSessionExit(child.id, { exitCode: 0, outputChars: 100, tail: 'done' })
    await settle()

    expect(getRavel(id)?.status).toBe('completed')
  })

  test("a child that wrote no report briefs the manager from its closing output", async () => {
    const fake = harness()
    const { id, child } = await ravelWithActiveChild(fake, 'Ravel tail')

    fake.script.push(toolBlock({ tool: 'complete', summary: 'Done.' }))
    onSessionExit(child.id, {
      exitCode: 0,
      outputChars: 200,
      tail: 'Rewrote src/auth.ts and added a regression test.'
    })
    await settle()

    const done = getRavel(id) as PublicRavelConfig
    // The manager gets something truthful to act on...
    expect(fake.prompts[fake.prompts.length - 1]).toContain('Rewrote src/auth.ts')
    expect(fake.prompts[fake.prompts.length - 1]).toContain('no report file')
    // ...but nothing is published, so no dependent can inherit the transcript.
    expect(done.dispatches[0].report).toBeNull()
  })

  test('a silent child still yields a null report rather than a fake one', async () => {
    const fake = harness()
    const { id, child } = await ravelWithActiveChild(fake, 'Ravel silent')

    fake.script.push(toolBlock({ tool: 'complete', summary: 'Done.' }))
    onSessionExit(child.id, { exitCode: 0, outputChars: 0, tail: '   ' })
    await settle()

    expect((getRavel(id) as PublicRavelConfig).dispatches[0].report).toBeNull()
  })
})

/**
 * A child's own account of its work is the least reliable evidence there is.
 * The repo's verify command is the only independent signal in the loop, so
 * these guard that it actually runs, in the right tree, and reaches the
 * manager before it decides what to do next.
 */
describe('Ravel child verification (no quota spend)', () => {
  async function ravelWithActiveChild(fake, name): Promise<{ id: string; child: Session }> {
    fake.script.push(toolBlock(planProposal([])))
    const created = await createRavel(
      { name, repoId: 'repo-1', repoPath: 'C:/repo', harness: 'claude', initialInstruction: 'Plan it' },
      SETTINGS
    )
    if (!created.ok) throw new Error('expected create to succeed')
    activeRavelId = created.ravel.id
    fake.script.length = 0
    fake.script.push(toolBlock(planProposal([created.ravel.messages[0].id])))
    await sendMessage(created.ravel.id, 'Plan it now', SETTINGS)
    fake.script.push(toolBlock({ tool: 'spawn_child', briefId: 'brief-1' }))
    await approvePlan(created.ravel.id, 1, SETTINGS)
    await settle()
    return { id: created.ravel.id, child: fake.sessions[0] }
  }

  test("the manager is told the repo's verdict, not only what the child claimed", async () => {
    const fake = harness()
    const { id, child } = await ravelWithActiveChild(fake, 'Ravel verify')
    settingsOverride = { ...SETTINGS, verify: { global: 'npm test', perRepo: {} } }
    verifyOutcome = () => ({
      ok: false,
      exitCode: 1,
      stdout: '2 failed',
      stderr: 'auth.test.ts > refresh keeps the session alive',
      ranWith: 'bash'
    })

    fake.script.push(toolBlock({ tool: 'reply', body: 'Noted.' }))
    onSessionExit(child.id, { exitCode: 0, outputChars: 200, tail: 'All done, everything passes.' })
    await settle()

    // Ran once, in the child's own worktree, against the child's branch.
    expect(fake.verifies).toHaveLength(1)
    const dispatch = (getRavel(id) as PublicRavelConfig).dispatches[0]
    expect(fake.verifies[0].script).toBe('npm test')
    expect(fake.verifies[0].worktreePath).toBe(dispatch.worktreePath)
    expect(fake.verifies[0].branch).toBe(dispatch.branch)
    expect(fake.verifies[0].repoPath).toBe('C:/repo')

    // Persisted, so the Fleet surface and a later resume both see it.
    expect(dispatch.verification).toEqual({
      ok: false,
      output: '2 failed\nauth.test.ts > refresh keeps the session alive'
    })

    // And the manager decides with the contradiction in front of it.
    const directive = fake.prompts[fake.prompts.length - 1]
    expect(directive).toContain('VERIFY COMMAND FAILED')
    expect(directive).toContain('auth.test.ts > refresh keeps the session alive')
    expect(directive).toContain('All done, everything passes.')
    expect(getLog(id).some((entry) => entry.event === 'verify' && entry.text.includes('verify failed'))).toBe(true)
  })

  test('no configured command runs nothing and leaves the dispatch unverified', async () => {
    const fake = harness()
    const { id, child } = await ravelWithActiveChild(fake, 'Ravel unverified')

    fake.script.push(toolBlock({ tool: 'reply', body: 'Noted.' }))
    onSessionExit(child.id, { exitCode: 0, outputChars: 200, tail: 'Done.' })
    await settle()

    expect(fake.verifies).toHaveLength(0)
    expect((getRavel(id) as PublicRavelConfig).dispatches[0].verification).toBeNull()
    expect(fake.prompts[fake.prompts.length - 1]).not.toContain('VERIFY COMMAND')
  })

  test('a configured verify command is skipped (fail-closed) without shell consent', async () => {
    const fake = harness()
    const { id, child } = await ravelWithActiveChild(fake, 'Ravel no consent')
    // Verify IS configured, but the operator has not granted shell consent.
    settingsOverride = {
      ...SETTINGS,
      verify: { global: 'npm test', perRepo: {} },
      shellHooksConsented: false
    }

    fake.script.push(toolBlock({ tool: 'reply', body: 'Noted.' }))
    onSessionExit(child.id, { exitCode: 0, outputChars: 100, tail: 'done' })
    await settle()

    // The shell never ran, and the dispatch is fail-closed: a not-run failure,
    // never a silent pass.
    expect(fake.verifies).toHaveLength(0)
    const verification = (getRavel(id) as PublicRavelConfig).dispatches[0].verification
    expect(verification?.ok).toBe(false)
    expect(verification?.output).toContain('shell execution consent')
    expect(getLog(id).some((e) => e.event === 'verify' && e.text.includes('shell consent required'))).toBe(true)
  })

  test('a per-repo command replaces the global one rather than running after it', async () => {
    const fake = harness()
    const { child } = await ravelWithActiveChild(fake, 'Ravel per-repo verify')
    settingsOverride = {
      ...SETTINGS,
      verify: { global: 'npm test', perRepo: { 'repo-1': 'cargo test' } }
    }

    fake.script.push(toolBlock({ tool: 'reply', body: 'Noted.' }))
    onSessionExit(child.id, { exitCode: 0, outputChars: 200, tail: 'Done.' })
    await settle()

    expect(fake.verifies.map((entry) => entry.script)).toEqual(['cargo test'])
  })

  test('a verify command that cannot start fails the verification, not the exit', async () => {
    const fake = harness()
    const { id, child } = await ravelWithActiveChild(fake, 'Ravel verify broken')
    settingsOverride = { ...SETTINGS, verify: { global: 'npm test', perRepo: {} } }
    verifyOutcome = () => {
      throw new Error('spawn bash ENOENT')
    }

    fake.script.push(toolBlock({ tool: 'reply', body: 'Noted.' }))
    onSessionExit(child.id, { exitCode: 0, outputChars: 200, tail: 'Done.' })
    await settle()

    const done = getRavel(id) as PublicRavelConfig
    expect(done.dispatches[0].verification?.ok).toBe(false)
    expect(done.dispatches[0].verification?.output).toContain('spawn bash ENOENT')
    // The exit still advances the fleet: an unrunnable check is not a stall.
    expect(done.dispatches[0].status).toBe('completed')
    expect(fake.prompts[fake.prompts.length - 1]).toContain('VERIFY COMMAND FAILED')
  })

  test('the manager is not invoked for an exit until that exit has been verified', async () => {
    const fake = harness()
    const { child } = await ravelWithActiveChild(fake, 'Ravel ordering')
    settingsOverride = { ...SETTINGS, verify: { global: 'npm test', perRepo: {} } }
    let release: ((result: HookResult) => void) | null = null
    verifyOutcome = () =>
      new Promise<HookResult>((resolve) => {
        release = resolve
      })

    const promptsBefore = fake.prompts.length
    fake.script.push(toolBlock({ tool: 'reply', body: 'Noted.' }))
    onSessionExit(child.id, { exitCode: 0, outputChars: 100, tail: 'Done.' })
    await settle()

    // The verdict is still open, so the manager has not been told anything.
    expect(release).not.toBeNull()
    expect(fake.prompts.length).toBe(promptsBefore)

    ;(release as ((result: HookResult) => void) | null)?.({ ok: true, exitCode: 0, stdout: 'suite green', stderr: '', ranWith: 'fake' })
    await settle()

    expect(fake.prompts.length).toBe(promptsBefore + 1)
    expect(fake.prompts[fake.prompts.length - 1]).toContain('VERIFY COMMAND PASSED')
  })

  test('a fleet cannot be completed while another child is still being verified', async () => {
    const fake = harness()
    fake.script.push(toolBlock(twoBriefPlan([])))
    const created = await createRavel(
      { name: 'Ravel two', repoId: 'repo-1', repoPath: 'C:/repo', harness: 'claude', initialInstruction: 'Plan it' },
      SETTINGS
    )
    if (!created.ok) throw new Error('expected create to succeed')
    activeRavelId = created.ravel.id
    fake.script.length = 0
    fake.script.push(toolBlock(twoBriefPlan([created.ravel.messages[0].id])))
    await sendMessage(created.ravel.id, 'Plan it now', SETTINGS)
    fake.script.push(
      toolBlock({ tool: 'spawn_child', briefId: 'brief-1' }) + toolBlock({ tool: 'spawn_child', briefId: 'brief-2' })
    )
    await approvePlan(created.ravel.id, 1, SETTINGS)
    await settle()
    const [first, second] = fake.sessions
    expect(second).toBeDefined()

    settingsOverride = { ...SETTINGS, verify: { global: 'npm test', perRepo: {} } }
    const pending: Array<(result: HookResult) => void> = []
    verifyOutcome = () => new Promise<HookResult>((resolve) => pending.push(resolve))

    // Both children finish; the second's verdict is still open when the first
    // exit's turn runs, and that turn tries to declare the fleet done.
    // One scripted turn per exit: the first tries to complete too early, the
    // second tries again once nothing is outstanding.
    fake.script.push(toolBlock({ tool: 'complete', summary: 'All done.' }))
    fake.script.push(toolBlock({ tool: 'complete', summary: 'All done.' }))
    onSessionExit(first.id, { exitCode: 0, outputChars: 100, tail: '' })
    onSessionExit(second.id, { exitCode: 0, outputChars: 100, tail: '' })
    await settle()
    pending.shift()?.({ ok: true, exitCode: 0, stdout: 'green', stderr: '', ranWith: 'fake' })
    await settle()

    expect((getRavel(created.ravel.id) as PublicRavelConfig).status).not.toBe('completed')
    expect(
      getLog(created.ravel.id).some((entry) => entry.text.includes('completion held back: still verifying brief-2'))
    ).toBe(true)

    // Once the last verdict lands, completing is allowed again.
    pending.shift()?.({ ok: true, exitCode: 0, stdout: 'green', stderr: '', ranWith: 'fake' })
    await settle()

    expect((getRavel(created.ravel.id) as PublicRavelConfig).status).toBe('completed')
  })
})

/**
 * Two ways the operator's own words enter the loop: a clarification they
 * answer, and a live child they want redirected. Neither may hand a role
 * anything the orchestrator did not choose to release.
 */
describe('Ravel operator interventions (no quota spend)', () => {
  async function ravelWithActiveChild(fake, name): Promise<{ id: string; child: Session }> {
    fake.script.push(toolBlock(planProposal([])))
    const created = await createRavel(
      { name, repoId: 'repo-1', repoPath: 'C:/repo', harness: 'claude', initialInstruction: 'Plan it' },
      SETTINGS
    )
    if (!created.ok) throw new Error('expected create to succeed')
    activeRavelId = created.ravel.id
    fake.script.length = 0
    fake.script.push(toolBlock(planProposal([created.ravel.messages[0].id])))
    await sendMessage(created.ravel.id, 'Plan it now', SETTINGS)
    fake.script.push(toolBlock({ tool: 'spawn_child', briefId: 'brief-1' }))
    await approvePlan(created.ravel.id, 1, SETTINGS)
    await settle()
    return { id: created.ravel.id, child: fake.sessions[0] }
  }

  test('a steer is addressed to the orchestrator; the child hears only what the orchestrator sends', async () => {
    const fake = harness()
    const { id, child } = await ravelWithActiveChild(fake, 'Ravel steer')
    const writesBefore = fake.writes[child.id].length

    fake.script.push(toolBlock({ tool: 'message_child', childId: child.id, body: 'Skip the refresh retry loop.' }))
    const result = await steerChild(id, child.id, 'Stop gold-plating, and remember ' + USER_SECRET_ASK, SETTINGS)
    await settle()

    expect(result?.ok).toBe(true)
    // The note is a message to Ravel, and reads that way in the transcript.
    const conversation = (getRavel(id) as PublicRavelConfig).messages
    expect(conversation.some((message) => message.author === 'user' && message.body.includes('Stop gold-plating'))).toBe(true)

    // The manager heard the note verbatim, addressed to a specific child...
    const directive = fake.prompts[fake.prompts.length - 1]
    expect(directive).toContain('Stop gold-plating')
    expect(directive).toContain(child.id)

    // ...and the child received only what the manager chose to send it.
    const delivered = fake.writes[child.id].slice(writesBefore).join('\n')
    expect(delivered).toContain('Skip the refresh retry loop.')
    expect(delivered).not.toContain('Stop gold-plating')
    expect(delivered).not.toContain(USER_SECRET_ASK)
  })

  test('steering refuses a child that is not live rather than inventing a recipient', async () => {
    const fake = harness()
    const { id, child } = await ravelWithActiveChild(fake, 'Ravel steer gone')
    const promptsBefore = fake.prompts.length

    const unknown = await steerChild(id, 'no-such-session', 'Do it differently', SETTINGS)
    expect(unknown).toMatchObject({ ok: false, error: { code: 'unknown-child' } })

    fake.script.push(toolBlock({ tool: 'reply', body: 'Noted.' }))
    onSessionExit(child.id, { exitCode: 0, outputChars: 100, tail: '' })
    await settle()

    const finished = await steerChild(id, child.id, 'Too late', SETTINGS)
    expect(finished).toMatchObject({ ok: false, error: { code: 'unknown-child' } })
    // Neither refusal spent a manager turn beyond the child-exit one.
    expect(fake.prompts.length).toBe(promptsBefore + 1)
  })

  test('a clarification may offer choices, clipped to what a question can honestly present', async () => {
    const fake = harness()
    fake.script.push(
      toolBlock({
        tool: 'ask_clarification',
        question: 'Which branch should I target?',
        options: ['main', '  develop  ', 'x'.repeat(200), '', 'release', 'legacy', 'sixth']
      })
    )
    const created = await createRavel(
      { name: 'Ravel options', repoId: 'repo-1', repoPath: 'C:/repo', harness: 'claude', initialInstruction: 'Vague' },
      SETTINGS
    )
    if (!created.ok) throw new Error('expected create to succeed')
    activeRavelId = created.ravel.id

    const question = created.ravel.messages.filter((message) => message.author === 'ravel').at(-1)
    expect(created.ravel.activity).toBe('needs-clarification')
    expect(question?.options).toEqual(['main', 'develop', 'x'.repeat(80), 'release', 'legacy'])
  })

  test('a clarification with no options is a plain question, not an empty menu', async () => {
    const fake = harness()
    fake.script.push(toolBlock({ tool: 'ask_clarification', question: 'What should I target?' }))
    const created = await createRavel(
      { name: 'Ravel plain', repoId: 'repo-1', repoPath: 'C:/repo', harness: 'claude', initialInstruction: 'Vague' },
      SETTINGS
    )
    if (!created.ok) throw new Error('expected create to succeed')
    activeRavelId = created.ravel.id

    expect(created.ravel.messages.at(-1)?.options).toBeUndefined()
  })
})

/**
 * The product's core promise: you talk to Ravel, Ravel holds the whole picture,
 * and no agent ever receives it — each gets only its own slice. Everything else
 * in this file is bookkeeping; this is the invariant worth guarding.
 */
describe('Ravel context partitioning (no quota spend)', () => {
  async function twoBriefRavel(fake) {
    fake.script.push(toolBlock(planProposal([])))
    const created = await createRavel(
      { name: 'Ravel boundary', repoId: 'repo-1', repoPath: 'C:/repo', harness: 'claude', initialInstruction: 'Fix auth' },
      SETTINGS
    )
    if (!created.ok) throw new Error('expected create to succeed')
    activeRavelId = created.ravel.id
    fake.script.length = 0
    fake.script.push(toolBlock(planWithDependency([created.ravel.messages[0].id])))
    await sendMessage(created.ravel.id, USER_SECRET_ASK, SETTINGS)
    fake.script.push(toolBlock({ tool: 'spawn_child', briefId: 'brief-1' }))
    await approvePlan(created.ravel.id, 1, SETTINGS)
    await settle()
    return created.ravel.id
  }

  test('a child receives its own brief and nothing belonging to anyone else', async () => {
    const fake = harness()
    await twoBriefRavel(fake)
    const prompt = fake.created[0].initialPrompt ?? ''

    expect(prompt).toContain('ROLE: Lead Engineer')
    expect(prompt).toContain('Repair the refresh path')
    expect(prompt).toContain('src/renderer/**')
    // The mission Ravel compiled.
    expect(prompt).not.toContain('Fix the auth refresh drop')
    expect(prompt).not.toContain(MISSION_CONTEXT)
    expect(prompt).not.toContain('Do not touch billing')
    // The user's own words.
    expect(prompt).not.toContain(USER_SECRET_ASK)
    // A sibling brief: not its goal, title, or acceptance criteria.
    expect(prompt).not.toContain('Review the refresh change')
    expect(prompt).not.toContain('Audit the refresh fix')
    expect(prompt).not.toContain('Findings ranked by severity')
  })

  test('the manager holds the mission but never a brief body', async () => {
    const fake = harness()
    await twoBriefRavel(fake)

    for (const prompt of fake.prompts) {
      expect(prompt).not.toContain('Repair the refresh path')
      expect(prompt).not.toContain('Review the refresh change')
    }
  })

  /**
   * The dependency handoff is the one sanctioned channel between children, so
   * it must carry a published artifact rather than whatever was on the other
   * agent's screen — a transcript routinely echoes its own brief back.
   */
  test('a dependent child never receives a sibling transcript', async () => {
    const fake = harness()
    await twoBriefRavel(fake)
    const first = fake.sessions[0]

    fake.script.push(toolBlock({ tool: 'spawn_child', briefId: 'brief-2' }))
    onSessionExit(first.id, {
      exitCode: 0,
      outputChars: 500,
      tail: [
        'I was told: GOAL: Repair the refresh path',
        `MISSION: Fix the auth refresh drop`,
        MISSION_CONTEXT,
        USER_SECRET_ASK
      ].join('\n')
    })
    await settle()

    const dependent = fake.created[1]
    expect(dependent).toBeDefined()
    const prompt = dependent.initialPrompt ?? ''
    expect(prompt).toContain('ROLE: Auditor')
    expect(prompt).not.toContain(MISSION_CONTEXT)
    expect(prompt).not.toContain(USER_SECRET_ASK)
    expect(prompt).not.toContain('Fix the auth refresh drop')
    expect(prompt).not.toContain('Repair the refresh path')
  })

  test('the manager may see a transcript tail the dependents cannot', async () => {
    const fake = harness()
    const id = await twoBriefRavel(fake)
    const first = fake.sessions[0]

    fake.script.push(toolBlock({ tool: 'reply', body: 'Noted.' }))
    onSessionExit(first.id, { exitCode: 0, outputChars: 500, tail: 'Rewrote src/auth.ts by hand.' })
    await settle()

    expect(fake.prompts[fake.prompts.length - 1]).toContain('Rewrote src/auth.ts by hand.')
    // Never persisted, so it can never reach a dependent later.
    expect((getRavel(id) as PublicRavelConfig).dispatches[0].report).toBeNull()
  })
})

describe('Ravel shared orientation (no quota spend)', () => {
  const ORIENTATION = 'We are repairing session handling across the app.'

  test('every child gets the orientation and still no mission', async () => {
    const fake = harness()
    fake.script.push(toolBlock(planProposal([])))
    const created = await createRavel(
      { name: 'Ravel orient', repoId: 'repo-1', repoPath: 'C:/repo', harness: 'claude', initialInstruction: 'Fix auth' },
      SETTINGS
    )
    if (!created.ok) throw new Error('expected create to succeed')
    activeRavelId = created.ravel.id

    fake.script.length = 0
    fake.script.push(
      toolBlock({ ...planProposal([created.ravel.messages[0].id]), orientation: ORIENTATION })
    )
    await sendMessage(created.ravel.id, 'Plan it now', SETTINGS)
    fake.script.push(toolBlock({ tool: 'spawn_child', briefId: 'brief-1' }))
    await approvePlan(created.ravel.id, 1, SETTINGS)
    await settle()

    const prompt = fake.created[0].initialPrompt ?? ''
    expect(prompt).toContain(ORIENTATION)
    // Orientation is the exception, not a crack in the boundary.
    expect(prompt).not.toContain(MISSION_CONTEXT)
    expect(prompt).not.toContain('Fix the auth refresh drop')
  })

  /** An unbounded orientation would quietly become the mission. */
  test('an over-long orientation is clipped before it reaches anyone', async () => {
    const fake = harness()
    fake.script.push(toolBlock(planProposal([])))
    const created = await createRavel(
      { name: 'Ravel clip', repoId: 'repo-1', repoPath: 'C:/repo', harness: 'claude', initialInstruction: 'Fix auth' },
      SETTINGS
    )
    if (!created.ok) throw new Error('expected create to succeed')
    activeRavelId = created.ravel.id

    fake.script.length = 0
    fake.script.push(
      toolBlock({
        ...planProposal([created.ravel.messages[0].id]),
        orientation: `${'x'.repeat(5_000)} ${MISSION_CONTEXT}`
      })
    )
    await sendMessage(created.ravel.id, 'Plan it now', SETTINGS)

    const plan = (getRavel(created.ravel.id) as PublicRavelConfig).plan
    expect(plan?.orientation.length).toBeLessThanOrEqual(MAX_ORIENTATION_CHARS)
    expect(plan?.orientation).not.toContain(MISSION_CONTEXT)
  })

  test('a plan without an orientation still dispatches', async () => {
    const fake = harness()
    fake.script.push(toolBlock(planProposal([])))
    const created = await createRavel(
      { name: 'Ravel none', repoId: 'repo-1', repoPath: 'C:/repo', harness: 'claude', initialInstruction: 'Fix auth' },
      SETTINGS
    )
    if (!created.ok) throw new Error('expected create to succeed')
    activeRavelId = created.ravel.id

    fake.script.length = 0
    fake.script.push(toolBlock(planProposal([created.ravel.messages[0].id])))
    await sendMessage(created.ravel.id, 'Plan it now', SETTINGS)
    fake.script.push(toolBlock({ tool: 'spawn_child', briefId: 'brief-1' }))
    await approvePlan(created.ravel.id, 1, SETTINGS)
    await settle()

    expect(fake.created[0].initialPrompt).toContain('ROLE: Lead Engineer')
    expect(fake.created[0].initialPrompt).not.toContain('WHAT THIS IS PART OF')
  })
})
