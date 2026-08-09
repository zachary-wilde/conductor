import { describe, expect, it } from 'vitest'
import { EMPTY_RAVEL_USAGE } from '@shared/types'
import type {
  PublicRavelConfig,
  RavelBrief,
  RavelDispatchRecord,
  RavelLogEntry,
  RavelLogLevel,
  RavelPlan,
  RoundtableConfig,
  RoundtableSeat,
  RoundtableTurn,
  Session,
  SessionActivityEntry,
  SessionStatus
} from '@shared/types'
import type { EventKind } from './events'
import {
  normalizeFileActivity,
  normalizeRavelLog,
  normalizeRoundtableTurn,
  normalizeSessionExit,
  normalizeSessionStatus
} from './event-normalizer'

// The normalizers are pure projectors: same inputs, same event, no clock. These
// factories build fully-typed records with unremarkable defaults so each case
// overrides only the axis it exercises. Determinism (not uniqueness) is the
// goal — the journal owns ordering via its cursor.

const log = (over: Partial<RavelLogEntry> = {}): RavelLogEntry => ({
  id: 'log-1',
  ravelId: 'ravel-1',
  ts: 1_000,
  level: 'info',
  event: 'turn',
  text: 'did a thing',
  ...over
})

const brief = (over: Partial<RavelBrief> = {}): RavelBrief => ({
  id: 'brief-1',
  title: 'Brief',
  role: 'lead-engineer',
  harness: 'codex',
  model: 'codex-max',
  phase: 'implementation',
  goal: 'ship it',
  relevantContext: [],
  constraints: [],
  acceptanceCriteria: [],
  doNotTouch: [],
  expectedOutput: 'a diff',
  escalationConditions: [],
  dependsOn: [],
  contextExceptionReason: null,
  ...over
})

const dispatch = (over: Partial<RavelDispatchRecord> = {}): RavelDispatchRecord => ({
  briefId: 'brief-1',
  planRevision: 1,
  sessionId: 'child-1',
  branch: 'feat',
  worktreePath: '/wt',
  status: 'active',
  startedAt: 100,
  endedAt: null,
  baseCommit: null,
  usage: EMPTY_RAVEL_USAGE,
  report: null,
  contextRequests: 0,
  verification: null,
  ...over
})

const plan = (briefs: RavelBrief[]): RavelPlan => ({
  revision: 1,
  createdAt: 0,
  sourceMessageIds: [],
  mission: {
    goal: 'mission',
    context: [],
    constraints: [],
    acceptanceCriteria: [],
    assumptions: []
  },
  orientation: '',
  briefs,
  approvedAt: null,
  approvedRevision: null
})

const ravelCfg = (over: Partial<PublicRavelConfig> = {}): PublicRavelConfig => ({
  id: 'ravel-1',
  name: 'Ravel',
  repoId: 'repo-1',
  repoPath: '/repo',
  harness: 'claude',
  model: 'claude-sonnet',
  maxChildren: 4,
  allowRisky: false,
  status: 'running',
  activity: 'idle',
  managerSessionId: null,
  messages: [],
  plan: null,
  dispatches: [],
  createdAt: 0,
  error: null,
  usage: EMPTY_RAVEL_USAGE,
  ...over
})

const session = (over: Partial<Session> = {}): Session =>
  ({
    id: 'sess-1',
    repoId: 'repo-1',
    repoPath: '/repo',
    worktreePath: '/wt',
    branch: 'main',
    status: 'running',
    title: null,
    initialPrompt: null,
    createdAt: 10,
    lastActivityAt: 99,
    kind: 'normal',
    harness: 'claude',
    parentId: null,
    ravelId: null,
    ravelRole: null,
    briefId: null,
    ...over
  }) as Session

const fileActivity = (
  over: Partial<SessionActivityEntry> = {}
): SessionActivityEntry => ({
  id: 'fa-1',
  sessionId: 'sess-1',
  path: 'src/foo.ts',
  kind: 'edited',
  ts: 1_000,
  ...over
})

const seat = (over: Partial<RoundtableSeat> = {}): RoundtableSeat => ({
  id: 'seat-1',
  name: 'Opus',
  harness: 'claude',
  model: 'claude-opus',
  stance: 'the sceptic',
  ...over
})

const turn = (over: Partial<RoundtableTurn> = {}): RoundtableTurn => ({
  id: 'turn-1',
  seatId: 'seat-1',
  body: 'I disagree on performance grounds.',
  createdAt: 7,
  usage: EMPTY_RAVEL_USAGE,
  ...over
})

const roundtableCfg = (over: Partial<RoundtableConfig> = {}): RoundtableConfig => ({
  id: 'rt-1',
  name: 'Roundtable',
  repoId: 'repo-1',
  repoPath: '/repo',
  topic: 'which DB?',
  seats: [seat()],
  turns: [],
  maxTurns: 6,
  status: 'running',
  conclusion: null,
  error: null,
  usage: EMPTY_RAVEL_USAGE,
  createdAt: 0,
  ...over
})

describe('normalizeRavelLog', () => {
  it('tags a manager-level line (no childSessionId) as the orchestrator', () => {
    const evt = normalizeRavelLog(
      log({ childSessionId: undefined, event: 'complete', text: 'ravel finished' }),
      ravelCfg({ harness: 'codex', model: 'codex-max' })
    )

    expect(evt).toMatchObject({
      id: 'log-1',
      timestamp: 1_000,
      rootWorkflowId: 'ravel-1',
      rootWorkflowKind: 'ravel',
      repoId: 'repo-1',
      parentWorkerId: null,
      workerId: null,
      workerKind: 'ravel-manager',
      role: 'orchestrator',
      harness: 'codex',
      model: 'codex-max',
      attempt: 1,
      kind: 'lifecycle',
      summary: 'ravel finished',
      evidenceRefs: []
    })
    // Manager lines carry only the ravel id, never a brief / session id.
    expect(evt.source).toEqual({ ravelId: 'ravel-1' })
  })

  it('nulls repo / harness / model when the ravel config is unavailable', () => {
    const evt = normalizeRavelLog(log({ childSessionId: undefined }), null)
    expect(evt).toMatchObject({
      repoId: null,
      harness: null,
      model: null,
      role: 'orchestrator',
      workerKind: 'ravel-manager'
    })
  })

  it('resolves role / harness / model / attempt for a child line from dispatch + brief', () => {
    const cfg = ravelCfg({
      plan: plan([
        brief({ id: 'brief-A', role: 'auditor', harness: 'zai', model: 'glm' })
      ]),
      dispatches: [
        dispatch({ briefId: 'brief-A', sessionId: 'child-A', startedAt: 100 }),
        dispatch({ briefId: 'brief-A', sessionId: 'child-B', startedAt: 200 })
      ]
    })

    // First dispatch of brief-A -> attempt 1.
    const first = normalizeRavelLog(log({ childSessionId: 'child-A' }), cfg)
    expect(first).toMatchObject({
      workerId: 'child-A',
      workerKind: 'ravel-child',
      role: 'auditor',
      harness: 'zai',
      model: 'glm',
      attempt: 1
    })
    expect(first.source).toEqual({
      ravelId: 'ravel-1',
      briefId: 'brief-A',
      sessionId: 'child-A'
    })

    // Second dispatch of the SAME brief, later startedAt -> attempt 2.
    const second = normalizeRavelLog(log({ id: 'log-2', childSessionId: 'child-B' }), cfg)
    expect(second.attempt).toBe(2)
    expect(second.source.briefId).toBe('brief-A')
  })

  it('counts attempts only within the same brief, ignoring other briefs', () => {
    const cfg = ravelCfg({
      plan: plan([brief({ id: 'brief-A' }), brief({ id: 'brief-B' })]),
      dispatches: [
        dispatch({ briefId: 'brief-A', sessionId: 'child-A', startedAt: 100 }),
        dispatch({ briefId: 'brief-B', sessionId: 'child-B', startedAt: 150 }),
        dispatch({ briefId: 'brief-A', sessionId: 'child-C', startedAt: 200 })
      ]
    })
    // Third dispatch overall, but only the 2nd for brief-A.
    const evt = normalizeRavelLog(log({ childSessionId: 'child-C' }), cfg)
    expect(evt.attempt).toBe(2)
  })

  it('falls back to null context and attempt 1 when the dispatch is unknown', () => {
    const evt = normalizeRavelLog(log({ childSessionId: 'ghost' }), ravelCfg())
    expect(evt).toMatchObject({
      workerKind: 'ravel-child',
      workerId: 'ghost',
      role: null,
      harness: null,
      model: null,
      attempt: 1
    })
    expect(evt.source).toEqual({
      ravelId: 'ravel-1',
      sessionId: 'ghost'
    })
  })

  describe('kind mapping', () => {
    const cases: Array<{ event: string; level: RavelLogLevel; kind: EventKind }> = [
      { event: 'turn', level: 'info', kind: 'tool' },
      { event: 'turn', level: 'error', kind: 'failure' },
      { event: 'spawn', level: 'info', kind: 'lifecycle' },
      { event: 'spawn', level: 'error', kind: 'failure' },
      { event: 'child-exit', level: 'error', kind: 'failure' },
      { event: 'resume-brief', level: 'info', kind: 'lifecycle' },
      { event: 'complete', level: 'info', kind: 'lifecycle' },
      { event: 'verify', level: 'info', kind: 'verification' },
      // An errored verify is still a verification result, not a generic failure.
      { event: 'verify', level: 'error', kind: 'verification' },
      { event: 'approve', level: 'info', kind: 'approval' },
      { event: 'plan', level: 'info', kind: 'approval' },
      { event: 'plan-changes', level: 'info', kind: 'rejection' },
      { event: 'plan-invalid', level: 'info', kind: 'failure' },
      { event: 'budget', level: 'info', kind: 'budget' },
      { event: 'context-request', level: 'info', kind: 'control-request' },
      { event: 'pause', level: 'info', kind: 'control-result' },
      { event: 'resume', level: 'info', kind: 'control-result' },
      { event: 'retry', level: 'info', kind: 'control-result' },
      { event: 'assignment', level: 'info', kind: 'control-result' },
      { event: 'message', level: 'info', kind: 'tool' },
      { event: 'action', level: 'info', kind: 'tool' },
      { event: 'reply', level: 'info', kind: 'conversation' },
      // Unknown events fall through to lifecycle / failure by severity.
      { event: 'mystery', level: 'info', kind: 'lifecycle' },
      { event: 'mystery', level: 'error', kind: 'failure' }
    ]

    for (const { event, level, kind } of cases) {
      it(`maps ${event}/${level} -> ${kind}`, () => {
        const evt = normalizeRavelLog(log({ event, level }), null)
        expect(evt.kind).toBe(kind)
      })
    }
  })
})

describe('normalizeSessionStatus', () => {
  it('projects a normal session as its own session-scoped workflow', () => {
    const evt = normalizeSessionStatus(
      session({ id: 'sess-7', harness: 'codex', lastActivityAt: 42 }),
      'running' as SessionStatus
    )

    expect(evt).toEqual({
      id: 'sess-7:running',
      timestamp: 42,
      repoId: 'repo-1',
      rootWorkflowId: 'sess-7',
      rootWorkflowKind: 'session',
      parentWorkerId: null,
      workerId: 'sess-7',
      workerKind: 'session',
      role: null,
      harness: 'codex',
      model: null,
      attempt: 1,
      kind: 'lifecycle',
      summary: 'session running',
      evidenceRefs: [],
      source: { sessionId: 'sess-7' }
    })
  })

  it('marks an error status as a failure', () => {
    const evt = normalizeSessionStatus(session(), 'error')
    expect(evt.kind).toBe('failure')
    expect(evt.summary).toBe('session error')
    expect(evt.id).toBe('sess-1:error')
  })
})

describe('normalizeSessionExit', () => {
  it('treats a clean exit (code 0) as lifecycle', () => {
    const evt = normalizeSessionExit(session(), 0)
    expect(evt).toMatchObject({
      id: 'sess-1:exit',
      kind: 'lifecycle',
      summary: 'session exited (code 0)',
      rootWorkflowKind: 'session',
      workerKind: 'session',
      timestamp: 99
    })
  })

  it('treats a non-zero exit code as a failure', () => {
    const evt = normalizeSessionExit(session(), 13)
    expect(evt.kind).toBe('failure')
    expect(evt.summary).toBe('session exited (code 13)')
  })
})

describe('normalizeRoundtableTurn', () => {
  it('attributes a seat turn to the seat with its harness and model', () => {
    const cfg = roundtableCfg({
      seats: [seat({ id: 'seat-2', harness: 'zai', model: 'glm' })]
    })
    const evt = normalizeRoundtableTurn(cfg, turn({ id: 'turn-9', seatId: 'seat-2', body: 'no', createdAt: 55 }))

    expect(evt).toEqual({
      id: 'turn-9',
      timestamp: 55,
      repoId: 'repo-1',
      rootWorkflowId: 'rt-1',
      rootWorkflowKind: 'roundtable',
      parentWorkerId: null,
      workerId: 'seat-2',
      workerKind: 'roundtable-seat',
      role: null,
      harness: 'zai',
      model: 'glm',
      attempt: 1,
      kind: 'conversation',
      summary: 'no',
      evidenceRefs: [],
      source: { roundtableId: 'rt-1' }
    })
  })

  it('clips a long body to 199 chars plus an ellipsis', () => {
    const body = 'x'.repeat(250)
    const evt = normalizeRoundtableTurn(roundtableCfg(), turn({ body }))
    expect(evt.summary.length).toBe(200)
    expect(evt.summary.endsWith('\u2026')).toBe(true)
    expect(evt.summary.slice(0, 199)).toBe('x'.repeat(199))
  })

  it('leaves a short body untouched', () => {
    const evt = normalizeRoundtableTurn(roundtableCfg(), turn({ body: 'short' }))
    expect(evt.summary).toBe('short')
  })

  it('treats a seatless turn as an operator note with no worker', () => {
    const evt = normalizeRoundtableTurn(
      roundtableCfg(),
      turn({ seatId: null, body: 'operator interjection' })
    )
    expect(evt).toMatchObject({
      workerId: null,
      workerKind: null,
      harness: null,
      model: null,
      kind: 'conversation',
      summary: 'operator interjection'
    })
  })

  it('nulls harness / model when the seat id is not found', () => {
    const evt = normalizeRoundtableTurn(roundtableCfg(), turn({ seatId: 'ghost' }))
    expect(evt.workerKind).toBe('roundtable-seat')
    expect(evt.harness).toBeNull()
    expect(evt.model).toBeNull()
  })
})

describe('normalizeFileActivity', () => {
  it('projects a ravel-child activity into a ravel-rooted file event', () => {
    const evt = normalizeFileActivity(
      fileActivity({ id: 'fa-7', path: 'src/foo.ts', kind: 'edited', ts: 900 }),
      session({
        id: 'child-1',
        kind: 'ravel-child',
        ravelId: 'ravel-9',
        ravelRole: 'lead-engineer',
        briefId: 'brief-9',
        harness: 'claude',
        repoId: 'repo-2'
      })
    )

    expect(evt).toEqual({
      id: 'file:fa-7',
      timestamp: 900,
      repoId: 'repo-2',
      rootWorkflowId: 'ravel-9',
      rootWorkflowKind: 'ravel',
      parentWorkerId: null,
      workerId: 'child-1',
      workerKind: 'ravel-child',
      role: 'lead-engineer',
      harness: 'claude',
      model: null,
      attempt: 1,
      kind: 'file',
      summary: 'edited src/foo.ts',
      evidenceRefs: ['src/foo.ts'],
      source: { ravelId: 'ravel-9', briefId: 'brief-9', sessionId: 'child-1' }
    })
  })

  it('projects a normal-session activity as its own session-rooted event with no role', () => {
    const evt = normalizeFileActivity(
      fileActivity({ id: 'fa-2', path: 'README.md', kind: 'added', ts: 5 }),
      session({ id: 'sess-3', harness: 'codex', repoId: 'repo-3' })
    )

    expect(evt).toMatchObject({
      id: 'file:fa-2',
      timestamp: 5,
      repoId: 'repo-3',
      rootWorkflowId: 'sess-3',
      rootWorkflowKind: 'session',
      parentWorkerId: null,
      workerId: 'sess-3',
      workerKind: 'session',
      role: null,
      harness: 'codex',
      model: null,
      attempt: 1,
      kind: 'file',
      summary: 'added README.md',
      evidenceRefs: ['README.md'],
      source: { sessionId: 'sess-3' }
    })
    expect(evt.source).not.toHaveProperty('ravelId')
    expect(evt.source).not.toHaveProperty('briefId')
  })

  it('uses the entry kind as the summary verb for added / edited / removed', () => {
    const s = session({ id: 'sess-3' })
    expect(
      normalizeFileActivity(fileActivity({ kind: 'added' }), s).summary
    ).toBe('added src/foo.ts')
    expect(
      normalizeFileActivity(fileActivity({ kind: 'edited' }), s).summary
    ).toBe('edited src/foo.ts')
    expect(
      normalizeFileActivity(fileActivity({ kind: 'removed' }), s).summary
    ).toBe('removed src/foo.ts')
  })
})
