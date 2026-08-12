import { describe, expect, test } from 'vitest'
import type {
  ChildRavelRole,
  HarnessAvailability,
  HarnessId,
  RavelBrief,
  RavelConfig,
  RavelDispatchRecord,
  RavelMission,
  RavelPlan
} from '@shared/types'
import { RAVEL_BRIEF_PHASES } from '@shared/types'
import {
  applyBriefAssignmentToPlan,
  approveCurrentPlan,
  buildRolePrompt,
  canResumeInterruptedBrief,
  canSpawnBrief,
  createPlanRevision,
  interruptLiveDispatchesForRestart,
  isHarnessAvailable,
  ravelRoleLabel,
  validatePlanProposal,
  validateTranscriptContent
} from './ravel-model'

const NOW = 1_700_000
const LATER = NOW + 500
const FULL_CONTEXT_CHARS = 1_000

const harnessAvailability: Record<HarnessId, HarnessAvailability> = {
  claude: {
    id: 'claude',
    info: { id: 'claude', label: 'Claude Code', provider: 'Anthropic', blurb: 'claude', accent: '#d97757' },
    available: true
  },
  codex: {
    id: 'codex',
    info: { id: 'codex', label: 'Codex', provider: 'OpenAI', blurb: 'codex', accent: '#10a37f' },
    available: true
  },
  zai: {
    id: 'zai',
    info: { id: 'zai', label: 'ZAI', provider: 'Z.AI', blurb: 'zai', accent: '#ff9500' },
    available: true
  }
}

function unavailableHarness(id: HarnessId): Record<HarnessId, HarnessAvailability> {
  return {
    ...harnessAvailability,
    [id]: { ...harnessAvailability[id], available: false, reason: 'not installed' }
  }
}

function mission(overrides: Partial<RavelMission> = {}): RavelMission {
  return {
    goal: 'Ship Ravel role-scoped dispatch',
    context: ['Repo uses Electron and Vitest'],
    constraints: ['Do not call real harnesses'],
    acceptanceCriteria: ['Users approve the generated plan before spawn'],
    assumptions: ['Local worktree exists'],
    ...overrides
  }
}

function brief(overrides: Partial<RavelBrief> = {}): RavelBrief {
  return {
    id: 'lead',
    title: 'Implement model',
    model: null,
    role: 'lead-engineer',
    harness: 'claude',
    phase: 'implementation',
    goal: 'Implement the pure Ravel planning model',
    relevantContext: ['Use src/main/ravel-model.ts only'],
    constraints: ['Keep functions immutable'],
    acceptanceCriteria: ['All model tests pass'],
    doNotTouch: ['src/main/index.ts'],
    expectedOutput: 'A passing test report',
    escalationConditions: ['Validation ambiguity'],
    dependsOn: [],
    contextExceptionReason: null,
    ...overrides
  }
}

function proposal(
  overrides: Partial<{ sourceMessageIds: string[]; orientation: string; mission: RavelMission; briefs: RavelBrief[] }> = {}
) {
  return {
    sourceMessageIds: ['msg-a', 'msg-b'],
    orientation: 'Tidying the auth flow.',
    mission: mission(),
    briefs: [brief()],
    ...overrides
  }
}

function approvedPlan(overrides: Partial<RavelPlan> = {}): RavelPlan {
  return {
    revision: 2,
    createdAt: NOW,
    sourceMessageIds: ['msg-a', 'msg-b'],
    orientation: 'Tidying the auth flow.',
    mission: mission(),
    briefs: [brief()],
    approvedAt: NOW,
    approvedRevision: 2,
    ...overrides
  }
}

function ravel(overrides: Partial<RavelConfig> = {}): RavelConfig {
  return {
    id: 'ravel-1',
    name: 'Ravel',
    model: null,
    repoId: 'repo-1',
    repoPath: 'D:/repo',
    harness: 'claude',
    maxChildren: 2,
    allowRisky: false,
    status: 'running',
    activity: 'idle',
    managerSessionId: 'manager-session',
    messages: [
      { id: 'conversation', author: 'user', body: 'do not leak conversation history', createdAt: NOW, delivery: 'delivered' }
    ],
    plan: approvedPlan(),
    dispatches: [],
    createdAt: NOW,
    error: null,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: null },
    ...overrides
  }
}

function dispatch(overrides: Partial<RavelDispatchRecord> = {}): RavelDispatchRecord {
  return {
    briefId: 'lead',
    planRevision: 2,
    sessionId: 'session-lead',
    branch: 'ravel/lead',
    worktreePath: 'D:/repo/.worktrees/lead',
    status: 'active',
    startedAt: NOW,
    endedAt: null,
    baseCommit: 'b'.repeat(40),
    usage: { inputTokens: 0, outputTokens: 0, costUsd: null },
    report: null,
    contextRequests: 0,
    verification: null,
    ...overrides
  }
}

function expectErrorCodes(result: { ok: false; errors: Array<{ code: string }> }, codes: string[]) {
  expect(result.errors.map((error) => error.code)).toEqual(codes)
}

function snapshot<T>(value: T): T {
  return structuredClone(value)
}

describe('validatePlanProposal and createPlanRevision', () => {
  test('valid proposal creates revision 1 with no approval and preserves source message ids', () => {
    const validProposal = proposal()
    const result = validatePlanProposal({
      proposal: validProposal,
      previousPlan: null,
      now: NOW,
      fullContextChars: FULL_CONTEXT_CHARS,
      harnessAvailability
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected valid proposal')
    expect(result.plan.revision).toBe(1)
    expect(result.plan.createdAt).toBe(NOW)
    expect(result.plan.sourceMessageIds).toEqual(['msg-a', 'msg-b'])
    expect(result.plan.approvedAt).toBeNull()
    expect(result.plan.approvedRevision).toBeNull()
    expect(result.plan.briefs[0]).toEqual(validProposal.briefs[0])
  })

  test('createPlanRevision increments the previous revision and clears any approval', () => {
    const result = createPlanRevision({
      proposal: proposal(),
      previousPlan: approvedPlan({ revision: 4, approvedAt: NOW, approvedRevision: 4 }),
      now: LATER,
      fullContextChars: FULL_CONTEXT_CHARS,
      harnessAvailability
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected valid revision')
    expect(result.plan.revision).toBe(5)
    expect(result.plan.approvedAt).toBeNull()
    expect(result.plan.approvedRevision).toBeNull()
  })

  test('createPlanRevision snapshots mutable proposal data and leaves input unchanged', () => {
    const mutableProposal = proposal({
      mission: mission({
        context: ['context a'],
        constraints: ['constraint a'],
        acceptanceCriteria: ['acceptance a'],
        assumptions: ['assumption a']
      }),
      briefs: [
        brief({ id: 'lead', dependsOn: ['audit'] }),
        brief({ id: 'audit', role: 'auditor' })
      ]
    })
    const before = snapshot(mutableProposal)

    const result = createPlanRevision({
      proposal: mutableProposal,
      previousPlan: null,
      now: LATER,
      fullContextChars: FULL_CONTEXT_CHARS,
      harnessAvailability
    })

    expect(mutableProposal).toEqual(before)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected valid revision')
    expect(result.plan.sourceMessageIds).toEqual(mutableProposal.sourceMessageIds)
    expect(result.plan.sourceMessageIds).not.toBe(mutableProposal.sourceMessageIds)
    expect(result.plan.mission).toEqual(mutableProposal.mission)
    expect(result.plan.mission).not.toBe(mutableProposal.mission)
    expect(result.plan.mission.context).not.toBe(mutableProposal.mission.context)
    expect(result.plan.mission.constraints).not.toBe(mutableProposal.mission.constraints)
    expect(result.plan.mission.acceptanceCriteria).not.toBe(mutableProposal.mission.acceptanceCriteria)
    expect(result.plan.mission.assumptions).not.toBe(mutableProposal.mission.assumptions)
    expect(result.plan.briefs).toEqual(mutableProposal.briefs)
    expect(result.plan.briefs).not.toBe(mutableProposal.briefs)
    for (let index = 0; index < mutableProposal.briefs.length; index += 1) {
      expect(result.plan.briefs[index]).not.toBe(mutableProposal.briefs[index])
      expect(result.plan.briefs[index].relevantContext).not.toBe(mutableProposal.briefs[index].relevantContext)
      expect(result.plan.briefs[index].constraints).not.toBe(mutableProposal.briefs[index].constraints)
      expect(result.plan.briefs[index].acceptanceCriteria).not.toBe(mutableProposal.briefs[index].acceptanceCriteria)
      expect(result.plan.briefs[index].doNotTouch).not.toBe(mutableProposal.briefs[index].doNotTouch)
      expect(result.plan.briefs[index].escalationConditions).not.toBe(mutableProposal.briefs[index].escalationConditions)
      expect(result.plan.briefs[index].dependsOn).not.toBe(mutableProposal.briefs[index].dependsOn)
    }
  })

  test('rejects empty source ids and mission goal', () => {
    const result = validatePlanProposal({
      proposal: proposal({ sourceMessageIds: [], mission: mission({ goal: '  ' }) }),
      previousPlan: null,
      now: NOW,
      fullContextChars: FULL_CONTEXT_CHARS,
      harnessAvailability
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected validation errors')
    expectErrorCodes(result, ['source-message-ids-required', 'mission-goal-required'])
  })

  test('rejects a brief missing the fields that make it dispatchable', () => {
    const result = validatePlanProposal({
      proposal: proposal({
        briefs: [
          brief({
            id: '  ',
            title: '',
            goal: ' ',
            relevantContext: [],
            constraints: [],
            acceptanceCriteria: [],
            doNotTouch: [],
            expectedOutput: '',
            escalationConditions: []
          })
        ]
      }),
      previousPlan: null,
      now: NOW,
      fullContextChars: FULL_CONTEXT_CHARS,
      harnessAvailability
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected validation errors')
    // Empty elaboration arrays are fine on a single-brief plan; only the fields
    // without which there is nothing to dispatch are demanded.
    expectErrorCodes(result, [
      'brief-id-required',
      'brief-title-required',
      'brief-goal-required',
      'brief-expected-output-required'
    ])
  })

  /**
   * Detail scales with the work: a trivial request must not be forced to invent
   * acceptance criteria, because invented specifications are the hallucination
   * this validation exists to avoid.
   */
  test('accepts a single lightweight brief with empty elaboration arrays', () => {
    const result = validatePlanProposal({
      proposal: proposal({
        briefs: [
          brief({
            relevantContext: [],
            constraints: [],
            acceptanceCriteria: [],
            doNotTouch: [],
            escalationConditions: []
          })
        ]
      }),
      previousPlan: null,
      now: NOW,
      fullContextChars: FULL_CONTEXT_CHARS,
      harnessAvailability
    })

    expect(result.ok).toBe(true)
  })

  /** Boundaries only matter once there is somebody else to collide with. */
  test('requires do-not-touch boundaries as soon as a plan fans out', () => {
    const result = validatePlanProposal({
      proposal: proposal({
        briefs: [
          brief({ id: 'one', doNotTouch: [] }),
          brief({ id: 'two', doNotTouch: [] })
        ]
      }),
      previousPlan: null,
      now: NOW,
      fullContextChars: FULL_CONTEXT_CHARS,
      harnessAvailability
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected validation errors')
    expect(result.errors.filter((item) => item.code === 'brief-do-not-touch-required')).toHaveLength(2)
  })

  test('returns validation errors instead of throwing for malformed manager JSON arrays', () => {
    const malformedProposal = proposal({
      mission: mission({
        context: { not: 'array' } as unknown as string[],
        constraints: undefined as unknown as string[],
        acceptanceCriteria: { not: 'array' } as unknown as string[],
        assumptions: undefined as unknown as string[]
      }),
      briefs: [
        brief({
          relevantContext: undefined as unknown as string[],
          constraints: { not: 'array' } as unknown as string[]
        })
      ]
    })

    const result = validatePlanProposal({
      proposal: malformedProposal,
      previousPlan: null,
      now: NOW,
      fullContextChars: FULL_CONTEXT_CHARS,
      harnessAvailability
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected validation errors')
    expect(result.errors.map((error) => error.code)).toEqual(
      expect.arrayContaining([
        'mission-context-required',
        'mission-constraints-required',
        'mission-acceptance-criteria-required',
        'mission-assumptions-required',
        'brief-relevant-context-invalid',
        'brief-constraints-invalid'
      ])
    )
  })

  test('allows empty mission arrays but rejects non-array assumptions without throwing', () => {
    const emptyMissionArrays = validatePlanProposal({
      proposal: proposal({
        mission: mission({ context: [], constraints: [], acceptanceCriteria: [], assumptions: [] })
      }),
      previousPlan: null,
      now: NOW,
      fullContextChars: FULL_CONTEXT_CHARS,
      harnessAvailability
    })

    expect(emptyMissionArrays.ok).toBe(true)

    const nonArrayAssumptions = validatePlanProposal({
      proposal: proposal({
        mission: mission({ assumptions: { not: 'array' } as unknown as string[] })
      }),
      previousPlan: null,
      now: NOW,
      fullContextChars: FULL_CONTEXT_CHARS,
      harnessAvailability
    })

    expect(nonArrayAssumptions.ok).toBe(false)
    if (nonArrayAssumptions.ok) throw new Error('expected validation errors')
    expect(nonArrayAssumptions.errors.map((error) => error.code)).toContain('mission-assumptions-required')
  })

  test('rejects duplicate brief ids, orchestrator child role, and unavailable harnesses', () => {
    const result = validatePlanProposal({
      proposal: proposal({
        briefs: [
          brief({ id: 'same', role: 'orchestrator' as ChildRavelRole }),
          brief({ id: 'same', harness: 'zai' })
        ]
      }),
      previousPlan: null,
      now: NOW,
      fullContextChars: FULL_CONTEXT_CHARS,
      harnessAvailability: unavailableHarness('zai')
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected validation errors')
    expectErrorCodes(result, ['brief-role-invalid', 'brief-duplicate-id', 'brief-harness-unavailable'])
  })

  test('rejects a phase the store would refuse, and names the vocabulary the manager may use', () => {
    const result = validatePlanProposal({
      // "research" is what an older prompt asked for; the store only accepts
      // the three canonical phases, so a plan carrying it used to validate and
      // then throw on save.
      proposal: proposal({ briefs: [brief({ phase: 'research' as RavelBrief['phase'] })] }),
      previousPlan: null,
      now: NOW,
      fullContextChars: FULL_CONTEXT_CHARS,
      harnessAvailability
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected validation errors')
    const phaseError = result.errors.find((error) => error.code === 'brief-phase-invalid')
    expect(phaseError?.message).toContain('before-implementation')
    expect(phaseError?.field).toBe('briefs.0.phase')

    // Every phase the manager is told about must survive validation, or the
    // prompt is documenting a schema the code rejects.
    for (const phase of RAVEL_BRIEF_PHASES) {
      const accepted = validatePlanProposal({
        proposal: proposal({ briefs: [brief({ phase })] }),
        previousPlan: null,
        now: NOW,
        fullContextChars: FULL_CONTEXT_CHARS,
        harnessAvailability
      })
      expect(accepted.ok).toBe(true)
    }
  })

  test('rejects unknown dependencies and dependency cycles', () => {
    const result = validatePlanProposal({
      proposal: proposal({
        briefs: [
          brief({ id: 'a', dependsOn: ['missing', 'b'] }),
          brief({ id: 'b', dependsOn: ['c'] }),
          brief({ id: 'c', dependsOn: ['b'] })
        ]
      }),
      previousPlan: null,
      now: NOW,
      fullContextChars: FULL_CONTEXT_CHARS,
      harnessAvailability
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected validation errors')
    expectErrorCodes(result, ['brief-dependency-unknown', 'brief-dependency-cycle'])
  })

  test('rejects brief serialized context at or above full context size without a non-empty exception reason', () => {
    const longContext = 'x'.repeat(FULL_CONTEXT_CHARS)
    const result = validatePlanProposal({
      proposal: proposal({ briefs: [brief({ relevantContext: [longContext], contextExceptionReason: '   ' })] }),
      previousPlan: null,
      now: NOW,
      fullContextChars: FULL_CONTEXT_CHARS,
      harnessAvailability
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected validation errors')
    expectErrorCodes(result, ['brief-context-exception-required'])
  })
})

describe('approveCurrentPlan', () => {
  test('stale approval reports the current and requested revisions', () => {
    const result = approveCurrentPlan(ravel({ plan: approvedPlan({ revision: 3, approvedAt: null, approvedRevision: null }) }), {
      planRevision: 2,
      now: LATER
    })

    expect(result).toEqual({ ok: false, error: { code: 'stale-revision', currentRevision: 3, requestedRevision: 2 } })
  })

  test('current approval stamps revision and time', () => {
    const inputPlan = approvedPlan({ revision: 3, approvedAt: null, approvedRevision: null })
    const result = approveCurrentPlan(ravel({ plan: inputPlan }), { planRevision: 3, now: LATER })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected approval')
    expect(result.plan).not.toBe(inputPlan)
    expect(result.plan.approvedRevision).toBe(3)
    expect(result.plan.approvedAt).toBe(LATER)
  })

  test('does not mutate ravel or approval inputs', () => {
    const input = ravel({ plan: approvedPlan({ revision: 3, approvedAt: null, approvedRevision: null }) })
    const request = { planRevision: 3, now: LATER }
    const beforeInput = snapshot(input)
    const beforeRequest = snapshot(request)

    approveCurrentPlan(input, request)

    expect(input).toEqual(beforeInput)
    expect(request).toEqual(beforeRequest)
  })
})

describe('applyBriefAssignmentToPlan', () => {
  test('applying role and harness to a current brief creates the next unapproved revision', () => {
    const plan = approvedPlan({ revision: 2, approvedAt: NOW, approvedRevision: 2 })
    const result = applyBriefAssignmentToPlan(ravel({ plan }), {
      planRevision: 2,
      briefId: 'lead',
      assignment: { role: 'auditor', harness: 'codex' },
      now: LATER,
      fullContextChars: FULL_CONTEXT_CHARS,
      harnessAvailability
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected mutation')
    expect(result.plan.revision).toBe(3)
    expect(result.plan.approvedAt).toBeNull()
    expect(result.plan.approvedRevision).toBeNull()
    expect(result.plan.sourceMessageIds).toEqual(plan.sourceMessageIds)
    expect(result.plan.briefs).toHaveLength(1)
    expect(result.plan.briefs[0]).toMatchObject({ id: 'lead', role: 'auditor', harness: 'codex' })
  })

  test('model overrides set, persist across unrelated edits, and clear on explicit null', () => {
    const base = ravel({ plan: approvedPlan({ revision: 2, approvedAt: NOW, approvedRevision: 2 }) })
    const assigned = applyBriefAssignmentToPlan(base, {
      planRevision: 2,
      briefId: 'lead',
      assignment: { model: '  opus  ' },
      now: LATER,
      fullContextChars: FULL_CONTEXT_CHARS,
      harnessAvailability
    })
    if (!assigned.ok) throw new Error('expected mutation')
    expect(assigned.plan.briefs[0].model).toBe('opus')

    const roleOnly = applyBriefAssignmentToPlan(ravel({ plan: assigned.plan }), {
      planRevision: assigned.plan.revision,
      briefId: 'lead',
      assignment: { role: 'auditor' },
      now: LATER,
      fullContextChars: FULL_CONTEXT_CHARS,
      harnessAvailability
    })
    if (!roleOnly.ok) throw new Error('expected mutation')
    expect(roleOnly.plan.briefs[0]).toMatchObject({ role: 'auditor', model: 'opus' })

    const cleared = applyBriefAssignmentToPlan(ravel({ plan: roleOnly.plan }), {
      planRevision: roleOnly.plan.revision,
      briefId: 'lead',
      assignment: { model: null },
      now: LATER,
      fullContextChars: FULL_CONTEXT_CHARS,
      harnessAvailability
    })
    if (!cleared.ok) throw new Error('expected mutation')
    expect(cleared.plan.briefs[0].model).toBeNull()
  })

  test('rejects a blank model override instead of storing an empty flag value', () => {
    const result = applyBriefAssignmentToPlan(ravel({ plan: approvedPlan({ revision: 2 }) }), {
      planRevision: 2,
      briefId: 'lead',
      assignment: { model: '   ' },
      now: LATER,
      fullContextChars: FULL_CONTEXT_CHARS,
      harnessAvailability
    })

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'brief-model-invalid',
        message: 'Model override cannot be blank; clear it instead.',
        field: 'model',
        briefId: 'lead'
      }
    })
  })

  test('rejects stale, unknown, and invalid assignments', () => {
    const stale = applyBriefAssignmentToPlan(ravel({ plan: approvedPlan({ revision: 4 }) }), {
      planRevision: 3,
      briefId: 'lead',
      assignment: { role: 'auditor' },
      now: LATER,
      fullContextChars: FULL_CONTEXT_CHARS,
      harnessAvailability
    })
    expect(stale).toEqual({ ok: false, error: { code: 'stale-revision', currentRevision: 4, requestedRevision: 3 } })

    const unknown = applyBriefAssignmentToPlan(ravel(), {
      planRevision: 2,
      briefId: 'missing',
      assignment: { role: 'auditor' },
      now: LATER,
      fullContextChars: FULL_CONTEXT_CHARS,
      harnessAvailability
    })
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.error.code).toBe('brief-not-found')

    const invalid = applyBriefAssignmentToPlan(ravel(), {
      planRevision: 2,
      briefId: 'lead',
      assignment: { role: 'orchestrator' as ChildRavelRole, harness: 'zai' },
      now: LATER,
      fullContextChars: FULL_CONTEXT_CHARS,
      harnessAvailability: unavailableHarness('zai')
    })
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) expect(invalid.error.code).toBe('brief-role-invalid')
  })

  test('rejects unavailable harness assignment directly', () => {
    const result = applyBriefAssignmentToPlan(ravel(), {
      planRevision: 2,
      briefId: 'lead',
      assignment: { harness: 'zai' },
      now: LATER,
      fullContextChars: FULL_CONTEXT_CHARS,
      harnessAvailability: unavailableHarness('zai')
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('brief-harness-unavailable')
  })

  test('rejects context-exception assignment directly', () => {
    const tooLarge = brief({ relevantContext: ['x'.repeat(FULL_CONTEXT_CHARS)], contextExceptionReason: null })
    const result = applyBriefAssignmentToPlan(ravel({ plan: approvedPlan({ briefs: [tooLarge] }) }), {
      planRevision: 2,
      briefId: 'lead',
      assignment: { role: 'auditor' },
      now: LATER,
      fullContextChars: FULL_CONTEXT_CHARS,
      harnessAvailability
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('brief-context-exception-required')
  })

  test('does not mutate ravel or assignment inputs', () => {
    const input = ravel({ plan: approvedPlan({ revision: 2, approvedAt: NOW, approvedRevision: 2 }) })
    const request = {
      planRevision: 2,
      briefId: 'lead',
      assignment: { role: 'auditor' as ChildRavelRole, harness: 'codex' as HarnessId },
      now: LATER,
      fullContextChars: FULL_CONTEXT_CHARS,
      harnessAvailability
    }
    const beforeInput = snapshot(input)
    const beforeRequest = snapshot(request)

    applyBriefAssignmentToPlan(input, request)

    expect(input).toEqual(beforeInput)
    expect(request).toEqual(beforeRequest)
  })
})

describe('canSpawnBrief', () => {
  test('rejects missing plan, unapproved plan, stale plan, inactive ravel statuses, and unknown brief', () => {
    expect(canSpawnBrief(ravel({ plan: null }), { briefId: 'lead', planRevision: 2, fullContextChars: FULL_CONTEXT_CHARS, harnessAvailability })).toMatchObject({ ok: false, error: { code: 'plan-required' } })
    expect(canSpawnBrief(ravel({ plan: approvedPlan({ approvedAt: null, approvedRevision: null }) }), { briefId: 'lead', planRevision: 2, fullContextChars: FULL_CONTEXT_CHARS, harnessAvailability })).toMatchObject({ ok: false, error: { code: 'plan-approval-required' } })
    expect(canSpawnBrief(ravel({ plan: approvedPlan({ revision: 3, approvedRevision: 3 }) }), { briefId: 'lead', planRevision: 2, fullContextChars: FULL_CONTEXT_CHARS, harnessAvailability })).toEqual({ ok: false, error: { code: 'stale-revision', currentRevision: 3, requestedRevision: 2 } })
    for (const status of ['paused', 'completed', 'error'] as const) {
      expect(canSpawnBrief(ravel({ status }), { briefId: 'lead', planRevision: 2, fullContextChars: FULL_CONTEXT_CHARS, harnessAvailability })).toMatchObject({ ok: false, error: { code: 'ravel-not-running' } })
    }
    expect(canSpawnBrief(ravel(), { briefId: 'missing', planRevision: 2, fullContextChars: FULL_CONTEXT_CHARS, harnessAvailability })).toMatchObject({ ok: false, error: { code: 'brief-not-found' } })
  })

  test('rejects unmet dependencies, duplicate live dispatch, unavailable harness, and missing context exception', () => {
    const dependent = brief({ id: 'dependent', dependsOn: ['lead'] })
    expect(canSpawnBrief(ravel({ plan: approvedPlan({ briefs: [brief(), dependent] }) }), { briefId: 'dependent', planRevision: 2, fullContextChars: FULL_CONTEXT_CHARS, harnessAvailability })).toMatchObject({ ok: false, error: { code: 'brief-dependencies-unmet' } })

    // The runtime owns adaptive capacity; model eligibility only validates the brief.
    expect(canSpawnBrief(ravel({ dispatches: [dispatch({ briefId: 'a' }), dispatch({ briefId: 'b', status: 'starting' })] }), { briefId: 'lead', planRevision: 2, fullContextChars: FULL_CONTEXT_CHARS, harnessAvailability })).toMatchObject({ ok: true })

    expect(canSpawnBrief(ravel({ dispatches: [dispatch()] }), { briefId: 'lead', planRevision: 2, fullContextChars: FULL_CONTEXT_CHARS, harnessAvailability })).toMatchObject({ ok: false, error: { code: 'brief-already-live' } })

    expect(canSpawnBrief(ravel(), { briefId: 'lead', planRevision: 2, fullContextChars: FULL_CONTEXT_CHARS, harnessAvailability: unavailableHarness('claude') })).toMatchObject({ ok: false, error: { code: 'brief-harness-unavailable' } })

    const tooLarge = brief({ relevantContext: ['x'.repeat(FULL_CONTEXT_CHARS)], contextExceptionReason: null })
    expect(canSpawnBrief(ravel({ plan: approvedPlan({ briefs: [tooLarge] }) }), { briefId: 'lead', planRevision: 2, fullContextChars: FULL_CONTEXT_CHARS, harnessAvailability })).toMatchObject({ ok: false, error: { code: 'brief-context-exception-required' } })
  })

  test('rejects completed and interrupted same-revision dispatches for the same brief', () => {
    expect(
      canSpawnBrief(ravel({ dispatches: [dispatch({ status: 'completed' })] }), {
        briefId: 'lead',
        planRevision: 2,
        fullContextChars: FULL_CONTEXT_CHARS,
        harnessAvailability
      })
    ).toMatchObject({ ok: false, error: { code: 'brief-already-completed' } })

    expect(
      canSpawnBrief(ravel({ dispatches: [dispatch({ status: 'interrupted' })] }), {
        briefId: 'lead',
        planRevision: 2,
        fullContextChars: FULL_CONTEXT_CHARS,
        harnessAvailability
      })
    ).toMatchObject({ ok: false, error: { code: 'brief-interrupted-requires-resume' } })
  })

  test('allows retry after a failed same-revision dispatch', () => {
    const approvedBrief = brief()
    const result = canSpawnBrief(ravel({ plan: approvedPlan({ briefs: [approvedBrief] }), dispatches: [dispatch({ status: 'failed' })] }), {
      briefId: 'lead',
      planRevision: 2,
      fullContextChars: FULL_CONTEXT_CHARS,
      harnessAvailability
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected failed dispatch to be retryable')
    expect(result.brief).toBe(approvedBrief)
  })

  test('success returns the exact approved brief object', () => {
    const approvedBrief = brief()
    const result = canSpawnBrief(
      ravel({ plan: approvedPlan({ briefs: [approvedBrief] }), dispatches: [dispatch({ briefId: 'audit', status: 'completed' })] }),
      { briefId: 'lead', planRevision: 2, fullContextChars: FULL_CONTEXT_CHARS, harnessAvailability }
    )

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected spawn eligibility')
    expect(result.brief).toBe(approvedBrief)
  })

  test('succeeds when an exact dependency completed on the current revision', () => {
    const dependency = brief({ id: 'research', role: 'auditor' })
    const target = brief({ id: 'lead', dependsOn: ['research'] })
    const result = canSpawnBrief(
      ravel({
        plan: approvedPlan({ briefs: [dependency, target] }),
        dispatches: [
          dispatch({ briefId: 'research', planRevision: 1, status: 'completed' }),
          dispatch({ briefId: 'research', planRevision: 2, status: 'completed' })
        ]
      }),
      { briefId: 'lead', planRevision: 2, fullContextChars: FULL_CONTEXT_CHARS, harnessAvailability }
    )

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected spawn eligibility')
    expect(result.brief).toBe(target)
  })

  test('does not mutate ravel or spawn inputs', () => {
    const input = ravel({ dispatches: [dispatch({ briefId: 'audit', status: 'completed' })] })
    const request = { briefId: 'lead', planRevision: 2, fullContextChars: FULL_CONTEXT_CHARS, harnessAvailability }
    const beforeInput = snapshot(input)
    const beforeRequest = snapshot(request)

    canSpawnBrief(input, request)

    expect(input).toEqual(beforeInput)
    expect(request).toEqual(beforeRequest)
  })
})

describe('buildRolePrompt', () => {
  test('contains scoped brief fields and explicit dependency outputs only', () => {
    const dependency = brief({ id: 'research', title: 'Research spike', goal: 'Find constraints' })
    const target = brief({ id: 'lead', dependsOn: ['research'] })
    const plan = approvedPlan({
      mission: mission({
        goal: 'mission goal secret',
        context: ['conversation history should be excluded']
      }),
      briefs: [target, dependency, brief({ id: 'unrelated', goal: 'unrelated brief secret' })]
    })

    const prompt = buildRolePrompt({
      brief: target,
      dependencyOutputs: {
        research: 'research output allowed',
        unrelated: 'unrelated output secret'
      }
    })

    expect(prompt).toContain('Lead Engineer')
    expect(prompt).toContain('GOAL')
    expect(prompt).toContain(target.goal)
    expect(prompt).toContain('RELEVANT CONTEXT')
    expect(prompt).toContain(target.relevantContext[0])
    expect(prompt).toContain('CONSTRAINTS')
    expect(prompt).toContain(target.constraints[0])
    expect(prompt).toContain('ACCEPTANCE CRITERIA')
    expect(prompt).toContain(target.acceptanceCriteria[0])
    expect(prompt).toContain('DO NOT TOUCH')
    expect(prompt).toContain(target.doNotTouch[0])
    expect(prompt).toContain('EXPECTED OUTPUT')
    expect(prompt).toContain(target.expectedOutput)
    expect(prompt).toContain('ESCALATION')
    expect(prompt).toContain(target.escalationConditions[0])
    expect(prompt).toContain('DEPENDENCY OUTPUTS')
    expect(prompt).toContain('research output allowed')
    expect(prompt).not.toContain(plan.mission.goal)
    expect(prompt).not.toContain(plan.mission.context[0])
    expect(prompt).not.toContain(plan.briefs[2].goal)
    expect(prompt).not.toContain('unrelated output secret')
  })
})

describe('interruptLiveDispatchesForRestart', () => {
  test('nulls manager session, pauses ravel, interrupts live dispatches, and does not mutate input', () => {
    const input = ravel({
      status: 'running',
      managerSessionId: 'manager-session',
      dispatches: [
        dispatch({ briefId: 'starting', status: 'starting' }),
        dispatch({ briefId: 'active', status: 'active' }),
        dispatch({ briefId: 'done', status: 'completed' })
      ]
    })

    const output = interruptLiveDispatchesForRestart(input)

    expect(output).not.toBe(input)
    expect(output.managerSessionId).toBeNull()
    expect(output.status).toBe('paused')
    expect(output.dispatches.map((item) => [item.briefId, item.status])).toEqual([
      ['starting', 'interrupted'],
      ['active', 'interrupted'],
      ['done', 'completed']
    ])
    expect(input.managerSessionId).toBe('manager-session')
    expect(input.status).toBe('running')
    expect(input.dispatches.map((item) => [item.briefId, item.status])).toEqual([
      ['starting', 'starting'],
      ['active', 'active'],
      ['done', 'completed']
    ])
  })
})

describe('canResumeInterruptedBrief', () => {
  test('requires the current approved revision and matching interrupted dispatch, returning existing branch and worktree', () => {
    const result = canResumeInterruptedBrief(
      ravel({ dispatches: [dispatch({ status: 'interrupted', branch: 'reuse-branch', worktreePath: 'D:/reuse' })] }),
      { briefId: 'lead', planRevision: 2 }
    )

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected resume eligibility')
    expect(result.branch).toBe('reuse-branch')
    expect(result.worktreePath).toBe('D:/reuse')
    expect(result.dispatch.status).toBe('interrupted')
  })

  test('does not mutate ravel or resume inputs', () => {
    const input = ravel({ dispatches: [dispatch({ status: 'interrupted', branch: 'reuse-branch', worktreePath: 'D:/reuse' })] })
    const request = { briefId: 'lead', planRevision: 2 }
    const beforeInput = snapshot(input)
    const beforeRequest = snapshot(request)

    canResumeInterruptedBrief(input, request)

    expect(input).toEqual(beforeInput)
    expect(request).toEqual(beforeRequest)
  })

  test('rejects unapproved, stale, missing, and non-interrupted dispatches', () => {
    expect(canResumeInterruptedBrief(ravel({ plan: approvedPlan({ approvedAt: null, approvedRevision: null }) }), { briefId: 'lead', planRevision: 2 })).toMatchObject({ ok: false, error: { code: 'plan-approval-required' } })
    expect(canResumeInterruptedBrief(ravel({ plan: approvedPlan({ revision: 3, approvedRevision: 3 }) }), { briefId: 'lead', planRevision: 2 })).toEqual({ ok: false, error: { code: 'stale-revision', currentRevision: 3, requestedRevision: 2 } })
    for (const status of ['paused', 'completed', 'error', 'idle', 'awaiting-approval'] as const) {
      expect(
        canResumeInterruptedBrief(
          ravel({ status, dispatches: [dispatch({ status: 'interrupted' })] }),
          { briefId: 'lead', planRevision: 2 }
        )
      ).toMatchObject({ ok: false, error: { code: 'ravel-not-running' } })
    }
    expect(canResumeInterruptedBrief(ravel({ dispatches: [] }), { briefId: 'lead', planRevision: 2 })).toMatchObject({ ok: false, error: { code: 'interrupted-dispatch-not-found' } })
    for (const status of ['starting', 'active', 'completed', 'failed'] as const) {
      expect(canResumeInterruptedBrief(ravel({ dispatches: [dispatch({ status })] }), { briefId: 'lead', planRevision: 2 })).toMatchObject({ ok: false, error: { code: 'interrupted-dispatch-not-found' } })
    }
  })
})
describe('validateTranscriptContent', () => {
  test('trims valid content and rejects empty or oversized content', () => {
    expect(validateTranscriptContent('  hello  ')).toEqual({ ok: true, body: 'hello' })
    expect(validateTranscriptContent('   ')).toEqual({
      ok: false,
      error: { code: 'message-body-required', message: 'Message body is required.' }
    })
    expect(validateTranscriptContent('x'.repeat(16_001))).toEqual({
      ok: false,
      error: { code: 'message-body-too-long', message: 'Message body must be 16,000 characters or fewer.' }
    })
  })
})


describe('labels and harness availability', () => {
  test('labels lead engineer, auditor, and minor task roles', () => {
    expect(ravelRoleLabel('lead-engineer')).toBe('Lead Engineer')
    expect(ravelRoleLabel('auditor')).toBe('Auditor')
    expect(ravelRoleLabel('minor-task')).toBe('Minor Task')
  })

  test('reports harness availability by id', () => {
    expect(isHarnessAvailable(harnessAvailability, 'claude')).toBe(true)
    expect(isHarnessAvailable(unavailableHarness('codex'), 'codex')).toBe(false)
  })
})
