import { describe, expect, test } from 'vitest'
import type { ChildRavelRole, PublicRavelConfig, RavelDispatchRecord, RavelLogEntry, RavelMessage, RavelPlan, RavelStatus, Session, SessionActivityEntry } from '@shared/types'
import {
  canApprovePlanInView,
  mergeRavelConfig,
  mergeRavelList,
  mergeRavelLogs,
  mergeRavelMessages,
  mergeRavelPlanByRevision,
  childRavelRoleLabel,
  ravelStatusLabel,
  ravelActivityLabel,
  fleetActivity
} from './ravelViewModel'

const NOW = 1_720_000_000_000

function message(overrides: Partial<RavelMessage> = {}): RavelMessage {
  return {
    id: 'msg-1',
    author: 'ravel',
    body: 'Ready',
    createdAt: NOW,
    delivery: 'delivered',
    ...overrides
  }
}

function log(overrides: Partial<RavelLogEntry> = {}): RavelLogEntry {
  return {
    id: 'log-1',
    ravelId: 'ravel-1',
    ts: NOW,
    level: 'info',
    event: 'status',
    text: 'Ready',
    ...overrides
  }
}

function plan(overrides: Partial<RavelPlan> = {}): RavelPlan {
  return {
    revision: 1,
    createdAt: NOW,
    sourceMessageIds: ['msg-1'],
    orientation: 'Tidying the auth flow.',
    mission: {
      goal: 'Ship',
      context: [],
      constraints: [],
      acceptanceCriteria: [],
      assumptions: []
    },
    briefs: [],
    approvedAt: null,
    approvedRevision: null,
    ...overrides
  }
}

function dispatch(overrides: Partial<RavelDispatchRecord> = {}): RavelDispatchRecord {
  return {
    briefId: 'brief-1',
    planRevision: 2,
    sessionId: 'session-1',
    branch: 'ravel/brief-1',
    worktreePath: 'D:/repo/.worktrees/brief-1',
    status: 'active',
    startedAt: NOW,
    endedAt: null,
    baseCommit: 'd'.repeat(40),
    usage: { inputTokens: 0, outputTokens: 0, costUsd: null },
    report: null,
    contextRequests: 0,
    verification: null,
    ...overrides
  }
}

function ravel(overrides: Partial<PublicRavelConfig> = {}): PublicRavelConfig {
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

describe('mergeRavelPlanByRevision', () => {
  test('keeps the current plan when an incoming plan has an older revision', () => {
    const current = plan({ revision: 3, mission: { ...plan().mission, goal: 'current' } })
    const incoming = plan({ revision: 2, mission: { ...plan().mission, goal: 'stale' } })

    expect(mergeRavelPlanByRevision(current, incoming)).toBe(current)
  })

  test('accepts newer and equal revisions while letting an authoritative null clear current plan', () => {
    const current = plan({ revision: 2, approvedAt: null })
    const sameRevision = plan({ revision: 2, approvedAt: NOW + 1, approvedRevision: 2 })
    const newer = plan({ revision: 3 })

    expect(mergeRavelPlanByRevision(null, current)).toBe(current)
    expect(mergeRavelPlanByRevision(current, sameRevision)).toBe(sameRevision)
    expect(mergeRavelPlanByRevision(current, newer)).toBe(newer)
    expect(mergeRavelPlanByRevision(current, null)).toBeNull()
  })
})

describe('canApprovePlanInView', () => {
  test('allows approval only when the selected revision is current, idle, and unapproved', () => {
    const currentPlan = plan({ revision: 2 })

    expect(canApprovePlanInView(currentPlan, 2, false)).toBe(true)
    expect(canApprovePlanInView(null, 2, false)).toBe(false)
    expect(canApprovePlanInView(currentPlan, null, false)).toBe(false)
    expect(canApprovePlanInView(currentPlan, 1, false)).toBe(false)
    expect(canApprovePlanInView(currentPlan, 2, true)).toBe(false)
    expect(canApprovePlanInView(plan({ revision: 2, approvedAt: NOW, approvedRevision: 2 }), 2, false)).toBe(false)
  })
})

describe('ravelStatusLabel', () => {
  test.each<[RavelStatus, string]>([
    ['idle', 'Idle'],
    ['awaiting-approval', 'Awaiting approval'],
    ['running', 'Running'],
    ['paused', 'Paused'],
    ['completed', 'Completed'],
    ['error', 'Error']
  ])('labels %s as %s', (status, expected) => {
    expect(ravelStatusLabel(status)).toBe(expected)
  })
})

describe('ravelActivityLabel', () => {
  test.each([
    ['idle', 'Idle'],
    ['thinking', 'Thinking'],
    ['needs-clarification', 'Needs clarification']
  ] as const)('labels %s as %s', (activity, expected) => {
    expect(ravelActivityLabel(activity)).toBe(expected)
  })
})

describe('childRavelRoleLabel', () => {
  test.each<[ChildRavelRole, string]>([
    ['lead-engineer', 'Lead Engineer'],
    ['auditor', 'Auditor'],
    ['minor-task', 'Minor Task']
  ])('labels %s as %s', (role, expected) => {
    expect(childRavelRoleLabel(role)).toBe(expected)
  })
})

describe('message and log merging', () => {
  test('dedupes messages by id, sorts deterministically, and caps at 200 newest entries', () => {
    const oldMessages = Array.from({ length: 205 }, (_, index) =>
      message({ id: `msg-${index}`, createdAt: index, body: `old ${index}` })
    )
    const merged = mergeRavelMessages(oldMessages, [
      message({ id: 'msg-100', createdAt: 100, body: 'updated duplicate' }),
      message({ id: 'msg-new', createdAt: 204, body: 'same timestamp sorts by id' })
    ])

    expect(merged).toHaveLength(200)
    expect(merged[0].id).toBe('msg-6')
    expect(merged.map((item) => item.id)).not.toContain('msg-5')
    expect(merged.find((item) => item.id === 'msg-100')?.body).toBe('updated duplicate')
    expect(merged.slice(-2).map((item) => item.id)).toEqual(['msg-204', 'msg-new'])
  })

  test('preserves plan source messages preferentially while capping merged config messages', () => {
    const source = message({ id: 'source-msg', createdAt: 1, body: 'source' })
    const current = ravel({
      messages: [source],
      plan: plan({ revision: 2, sourceMessageIds: [source.id] })
    })
    const incoming = ravel({
      messages: Array.from({ length: 205 }, (_, index) =>
        message({ id: `new-msg-${index}`, createdAt: NOW + index, body: `new ${index}` })
      ),
      plan: plan({ revision: 2, sourceMessageIds: [source.id] })
    })

    const merged = mergeRavelConfig(current, incoming)

    expect(merged.messages).toHaveLength(200)
    expect(merged.messages.filter((item) => item.id === source.id)).toHaveLength(1)
    expect(merged.messages.map((item) => item.id)).toContain(source.id)
    expect(merged.messages.map((item) => item.id)).not.toContain('new-msg-0')
  })

  test('dedupes logs by id, sorts deterministically, and caps at 200 newest entries', () => {
    const oldLogs = Array.from({ length: 205 }, (_, index) =>
      log({ id: `log-${index}`, ts: index, text: `old ${index}` })
    )
    const merged = mergeRavelLogs(oldLogs, [
      log({ id: 'log-100', ts: 100, text: 'updated duplicate' }),
      log({ id: 'log-new', ts: 204, text: 'same timestamp sorts by id' })
    ])

    expect(merged).toHaveLength(200)
    expect(merged[0].id).toBe('log-6')
    expect(merged.map((item) => item.id)).not.toContain('log-5')
    expect(merged.find((item) => item.id === 'log-100')?.text).toBe('updated duplicate')
    expect(merged.slice(-2).map((item) => item.id)).toEqual(['log-204', 'log-new'])
  })
})

describe('config and list merging', () => {
  test('merges a whole config without letting a stale plan replace a newer local plan', () => {
    const current = ravel({
      status: 'awaiting-approval',
      messages: [message({ id: 'msg-1', createdAt: 1, body: 'local' })],
      plan: plan({ revision: 3, mission: { ...plan().mission, goal: 'newer local plan' } })
    })
    const incoming = ravel({
      status: 'running',
      messages: [message({ id: 'msg-1', createdAt: 1, body: 'remote update' }), message({ id: 'msg-2', createdAt: 2 })],
      plan: plan({ revision: 2, mission: { ...plan().mission, goal: 'stale incoming plan' } })
    })

    const merged = mergeRavelConfig(current, incoming)

    expect(merged.status).toBe('awaiting-approval')
    expect(merged.plan).toBe(current.plan)
    expect(merged.activity).toBe(current.activity)
    expect(merged.dispatches).toBe(current.dispatches)
    expect(merged.managerSessionId).toBe(current.managerSessionId)
    expect(merged.error).toBe(current.error)
    expect(merged.messages.map((item) => item.id)).toEqual(['msg-1', 'msg-2'])
    expect(merged.messages[0].body).toBe('remote update')
  })

  test('treats a whole-config null plan as stale when current runtime has a plan', () => {
    const currentPlan = plan({ revision: 2 })
    const current = ravel({
      status: 'awaiting-approval',
      activity: 'thinking',
      managerSessionId: 'manager-current',
      dispatches: [dispatch()],
      messages: [message({ id: 'msg-1', createdAt: 1 }), message({ id: 'plan-source', createdAt: 2 })],
      plan: currentPlan
    })
    const incoming = ravel({
      status: 'idle',
      activity: 'idle',
      managerSessionId: null,
      dispatches: [],
      messages: [message({ id: 'msg-1', createdAt: 1 })],
      plan: null
    })

    const merged = mergeRavelConfig(current, incoming)

    expect(merged.plan).toBe(currentPlan)
    expect(merged.status).toBe('awaiting-approval')
    expect(merged.activity).toBe('thinking')
    expect(merged.dispatches).toBe(current.dispatches)
    expect(merged.managerSessionId).toBe('manager-current')
    expect(merged.messages.map((item) => item.id)).toEqual(['msg-1', 'plan-source'])
  })

  test('does not let a stale pre-approval list response replace an approved equal-revision plan', () => {
    const approved = plan({ revision: 2, approvedAt: NOW + 10, approvedRevision: 2 })
    const preApproval = plan({ revision: 2, approvedAt: null, approvedRevision: null })
    const current = ravel({
      name: 'Current approved',
      status: 'running',
      activity: 'thinking',
      managerSessionId: 'manager-current',
      dispatches: [dispatch({ status: 'active' })],
      messages: [message({ id: 'msg-1', createdAt: 1 }), message({ id: 'approval', createdAt: 2 })],
      plan: approved
    })
    const incoming = ravel({
      name: 'Stale pre-approval',
      status: 'awaiting-approval',
      activity: 'idle',
      managerSessionId: null,
      dispatches: [],
      error: 'stale snapshot',
      messages: [message({ id: 'msg-1', createdAt: 1 })],
      plan: preApproval
    })

    const merged = mergeRavelConfig(current, incoming)
    expect(merged.plan).toBe(approved)
    expect(merged.name).toBe('Current approved')
    expect(merged.status).toBe('running')
    expect(merged.activity).toBe('thinking')
    expect(merged.managerSessionId).toBe('manager-current')
    expect(merged.dispatches).toBe(current.dispatches)
    expect(merged.error).toBeNull()
  })

  test('does not let a stale approved response replace an equal-revision plan after change request', () => {
    const requestedChanges = plan({ revision: 2, approvedAt: null, approvedRevision: null })
    const staleApproved = plan({ revision: 2, approvedAt: NOW, approvedRevision: 2 })
    const current = ravel({
      name: 'Current requested changes',
      status: 'awaiting-approval',
      activity: 'needs-clarification',
      managerSessionId: 'manager-current',
      dispatches: [dispatch({ status: 'interrupted' })],
      error: 'changes requested',
      messages: [message({ id: 'msg-1', createdAt: 1 }), message({ id: 'change-request', createdAt: 2 })],
      plan: requestedChanges
    })
    const incoming = ravel({
      name: 'Stale approved',
      status: 'running',
      activity: 'idle',
      managerSessionId: 'manager-stale',
      dispatches: [dispatch({ status: 'completed' })],
      error: null,
      messages: [message({ id: 'msg-1', createdAt: 1 })],
      plan: staleApproved
    })

    const merged = mergeRavelConfig(current, incoming)
    expect(merged.plan).toBe(requestedChanges)
    expect(merged.name).toBe('Current requested changes')
    expect(merged.status).toBe('awaiting-approval')
    expect(merged.activity).toBe('needs-clarification')
    expect(merged.managerSessionId).toBe('manager-current')
    expect(merged.dispatches).toBe(current.dispatches)
    expect(merged.error).toBe('changes requested')
  })

  test('allows a newer equal-revision change-request config to clear current approval', () => {
    const approved = plan({ revision: 2, approvedAt: NOW, approvedRevision: 2 })
    const requestedChanges = plan({ revision: 2, approvedAt: null, approvedRevision: null })
    const current = ravel({
      messages: [message({ id: 'msg-1', createdAt: 1 })],
      plan: approved
    })
    const incoming = ravel({
      messages: [message({ id: 'msg-1', createdAt: 1 }), message({ id: 'change-request', createdAt: 2 })],
      plan: requestedChanges
    })

    expect(mergeRavelConfig(current, incoming).plan).toBe(requestedChanges)
    const merged = mergeRavelConfig(current, {
      ...incoming,
      status: 'awaiting-approval',
      activity: 'needs-clarification',
      dispatches: [dispatch({ status: 'interrupted' })],
      managerSessionId: 'manager-newer'
    })

    expect(merged.status).toBe('awaiting-approval')
    expect(merged.activity).toBe('needs-clarification')
    expect(merged.dispatches).not.toBe(current.dispatches)
    expect(merged.managerSessionId).toBe('manager-newer')
  })

  test('inserts and updates list entries without duplicate ids', () => {
    const first = ravel({ id: 'ravel-1', name: 'First', createdAt: 2 })
    const second = ravel({ id: 'ravel-2', name: 'Second', createdAt: 1 })
    const updatedFirst = ravel({ id: 'ravel-1', name: 'First updated', createdAt: 3 })

    const inserted = mergeRavelList([], first)
    const appended = mergeRavelList(inserted, second)
    const updated = mergeRavelList(appended, updatedFirst)

    expect(updated.map((item) => item.id)).toEqual(['ravel-1', 'ravel-2'])
    expect(updated).toHaveLength(2)
    expect(updated[0].name).toBe('First updated')
  })
})

describe('fleetActivity', () => {
  const ravel = { id: 'ravel-1', repoId: 'repo-1' }

  function session(overrides: Partial<Session> = {}): Session {
    return {
      id: 'child-1',
      repoId: 'repo-1',
      repoPath: 'D:/repo',
      worktreePath: 'D:/repo/wt',
      branch: 'ravel/brief-1',
      harness: 'claude',
      status: 'running',
      title: null,
      initialPrompt: null,
      createdAt: NOW,
      lastActivityAt: NOW,
      kind: 'ravel-child',
      parentId: null,
      ravelId: 'ravel-1',
      ravelRole: 'lead-engineer',
      briefId: 'brief-1',
      ...overrides
    } as Session
  }

  const terminal = (overrides: Partial<Session> = {}): Session =>
    session({
      id: 'term-1',
      kind: 'normal',
      harness: null,
      ravelId: null,
      ravelRole: null,
      briefId: null,
      branch: 'work/manual',
      ...overrides
    } as Partial<Session>)

  function entry(sessionId: string, path: string, ts = NOW): SessionActivityEntry {
    return { id: `${sessionId}:${path}:${ts}`, sessionId, path, kind: 'edited', ts }
  }

  test('includes this ravel\'s children and marks them as not manual', () => {
    const rows = fleetActivity([entry('child-1', 'a.ts')], [session()], ravel)
    expect(rows).toHaveLength(1)
    expect(rows[0].manual).toBe(false)
    expect(rows[0].entry.path).toBe('a.ts')
  })

  /** The whole point: the fleet stops being blind to work done by hand. */
  test('includes a terminal on the same repo and marks it manual', () => {
    const rows = fleetActivity([entry('term-1', 'b.ts')], [terminal()], ravel)
    expect(rows).toHaveLength(1)
    expect(rows[0].manual).toBe(true)
  })

  test('excludes a terminal open on a different repository', () => {
    const rows = fleetActivity([entry('term-1', 'b.ts')], [terminal({ repoId: 'other' })], ravel)
    expect(rows).toEqual([])
  })

  test('excludes children belonging to another ravel', () => {
    const rows = fleetActivity([entry('child-1', 'a.ts')], [session({ ravelId: 'ravel-2' })], ravel)
    expect(rows).toEqual([])
  })

  /**
   * A harness session the operator started outside the ravel is another agent's
   * work. Showing it as "you" would be a lie the manual marker paints on screen.
   */
  test('excludes a stray harness session on the same repo', () => {
    const stray = terminal({ id: 'stray', harness: 'codex' })
    expect(fleetActivity([entry('stray', 'c.ts')], [stray], ravel)).toEqual([])
  })

  test('drops entries whose session is gone rather than showing an unattributed row', () => {
    expect(fleetActivity([entry('vanished', 'd.ts')], [], ravel)).toEqual([])
  })

  test('returns newest first and caps the list', () => {
    const many = Array.from({ length: 150 }, (_, i) => entry('term-1', `f${i}.ts`, NOW + i))
    const rows = fleetActivity(many, [terminal()], ravel)
    expect(rows).toHaveLength(120)
    expect(rows[0].entry.path).toBe('f149.ts')
    expect(rows[rows.length - 1].entry.path).toBe('f30.ts')
  })

  test('interleaves agent and manual work in one feed', () => {
    const rows = fleetActivity(
      [entry('child-1', 'a.ts', NOW), entry('term-1', 'b.ts', NOW + 1)],
      [session(), terminal()],
      ravel
    )
    expect(rows.map((r) => [r.entry.path, r.manual])).toEqual([
      ['b.ts', true],
      ['a.ts', false]
    ])
  })
})
