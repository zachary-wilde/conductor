import { describe, expect, test } from 'vitest'
import type { RavelConfig } from '@shared/types'
import {
  MANAGER_CONTEXT_BUDGET,
  buildManagerContext,
  parseToolCalls,
  type FleetSnapshot,
  type ManagerContext,
  type ManagerContextInput
} from './manager-turn'

const NOW = 1_700_000_000_000

function message(overrides: Partial<RavelConfig['messages'][number]> = {}): RavelConfig['messages'][number] {
  return { id: 'm-1', author: 'user', body: 'do the thing', createdAt: NOW, delivery: 'delivered', ...overrides }
}

function brief(id: string, title: string): RavelConfig['plan'] extends null ? never : NonNullable<RavelConfig['plan']>['briefs'][number] {
  return {
    id,
    title,
    role: 'lead-engineer',
    harness: 'claude',
    model: null,
    phase: 'implementation',
    goal: `GOAL BODY FOR ${id}`,
    relevantContext: ['src/main/auth.ts'],
    constraints: ['CONSTRAINT BODY'],
    acceptanceCriteria: ['ACCEPTANCE BODY'],
    doNotTouch: ['src/renderer/**'],
    expectedOutput: 'EXPECTED OUTPUT BODY',
    escalationConditions: ['ESCALATION BODY'],
    dependsOn: [],
    contextExceptionReason: null
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
    maxChildren: 4,
    allowRisky: false,
    status: 'running',
    activity: 'idle',
    managerSessionId: null,
    messages: [message()],
    plan: null,
    dispatches: [],
    createdAt: NOW,
    error: null,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: null },
    ...overrides
  }
}

const emptyFleet: FleetSnapshot = { children: [] }
const DIRECTIVE = 'The user sent a message. Respond or propose a plan.'

function context(overrides: Partial<ManagerContextInput> = {}): ManagerContext {
  return buildManagerContext({
    ravel: ravel(),
    fleet: emptyFleet,
    directive: DIRECTIVE,
    availableHarnesses: ['claude', 'codex'],
    ...overrides
  })
}

describe('buildManagerContext budget', () => {
  test('a normal turn stays well under the hard cap', () => {
    const built = context()
    expect(built.promptChars).toBeLessThan(MANAGER_CONTEXT_BUDGET.maxPromptChars)
    expect(built.prompt).toContain('do the thing')
  })

  test('the prompt states the plan schema and the harnesses a brief may use', () => {
    // Without this the model omits required brief fields, the proposal fails
    // validation three times, and the Ravel errors out. Observed with a real CLI.
    const built = context({ availableHarnesses: ['codex'] })
    for (const field of [
      'relevantContext',
      'doNotTouch',
      'expectedOutput',
      'escalationConditions',
      'acceptanceCriteria',
      'assumptions'
    ]) {
      expect(built.prompt).toContain(field)
    }
    expect(built.prompt).toContain('"lead-engineer"|"auditor"|"minor-task"')
    expect(built.prompt).toContain('available harnesses: codex')
  })

  test('only the most recent messages survive, oldest dropped first', () => {
    const messages = Array.from({ length: 40 }, (_, index) =>
      message({ id: `m-${index}`, body: `message-${index}`, createdAt: NOW + index })
    )
    const built = context({ ravel: ravel({ messages }) })

    expect(built.prompt).toContain('message-39')
    expect(built.prompt).not.toContain('message-0')
    expect(built.includedMessages).toBeLessThanOrEqual(
      MANAGER_CONTEXT_BUDGET.maxMessages + MANAGER_CONTEXT_BUDGET.maxPinnedSources
    )
  })

  test('the messages a plan was built from survive however far the chat has moved on', () => {
    const original = message({ id: 'source', body: 'Never persist the password.', createdAt: NOW })
    const messages = [
      original,
      ...Array.from({ length: 40 }, (_, index) =>
        message({ id: `m-${index}`, body: `chatter-${index}`, createdAt: NOW + index + 1 })
      )
    ]
    const plan = {
      revision: 1,
      createdAt: NOW,
      sourceMessageIds: ['source'],
      orientation: 'Tidying the auth flow.',
      mission: { goal: 'Fix login', context: [], constraints: [], acceptanceCriteria: [], assumptions: [] },
      briefs: [brief('brief-1', 'Repair refresh')],
      approvedAt: NOW,
      approvedRevision: 1
    }
    const built = context({ ravel: ravel({ messages, plan }) })

    expect(built.prompt).toContain('Never persist the password.')
    expect(built.prompt).toContain('chatter-39')
    expect(built.prompt).not.toContain('chatter-0')
    expect(built.promptChars).toBeLessThanOrEqual(MANAGER_CONTEXT_BUDGET.maxPromptChars)
  })

  test('the ratified mission rides every turn, and briefs declare what blocks them', () => {
    const blocked = { ...brief('audit', 'Audit tokens'), dependsOn: ['brief-1'] }
    const plan = {
      revision: 1,
      createdAt: NOW,
      sourceMessageIds: [],
      orientation: 'Tidying the auth flow.',
      mission: {
        goal: 'Fix login',
        context: [],
        constraints: ['Do not touch billing'],
        acceptanceCriteria: ['Email survives refresh'],
        assumptions: ['sessionStorage is available']
      },
      briefs: [brief('brief-1', 'Repair refresh'), blocked],
      approvedAt: NOW,
      approvedRevision: 1
    }
    const built = context({ ravel: ravel({ plan }) })

    // Approving a plan ratifies these; a manager that cannot see them will
    // violate them on the next child-exit turn.
    expect(built.prompt).toContain('Do not touch billing')
    expect(built.prompt).toContain('Email survives refresh')
    expect(built.prompt).toContain('sessionStorage is available')
    // Spawn order is decided from this line alone.
    expect(built.prompt).toContain('audit [lead-engineer/claude] Audit tokens · not dispatched ← brief-1')
  })

  test('a single enormous message cannot blow the cap', () => {
    const huge = message({ body: 'x'.repeat(80_000) })
    const built = context({ ravel: ravel({ messages: [huge] }) })
    expect(built.promptChars).toBeLessThanOrEqual(MANAGER_CONTEXT_BUDGET.maxPromptChars)
  })

  test('the plan is digested to ids and titles, never full brief bodies', () => {
    const plan = {
      revision: 3,
      createdAt: NOW,
      sourceMessageIds: ['m-1'],
      orientation: 'Tidying the auth flow.',
      mission: {
        goal: 'Fix auth',
        context: ['MISSION CONTEXT BODY'],
        constraints: [],
        acceptanceCriteria: [],
        assumptions: []
      },
      briefs: [brief('brief-1', 'Repair refresh'), brief('brief-2', 'Audit tokens')],
      approvedAt: null,
      approvedRevision: null
    }
    const built = context({ ravel: ravel({ plan }) })

    expect(built.prompt).toContain('brief-1')
    expect(built.prompt).toContain('Repair refresh')
    expect(built.prompt).not.toContain('GOAL BODY FOR brief-1')
    expect(built.prompt).not.toContain('EXPECTED OUTPUT BODY')
    expect(built.prompt).not.toContain('ESCALATION BODY')
  })

  test('a plan with hundreds of briefs is capped instead of overflowing the prompt', () => {
    const briefs = Array.from({ length: 300 }, (_, index) => brief(`brief-${index}`, `Title ${index}`))
    const plan = {
      revision: 1,
      createdAt: NOW,
      sourceMessageIds: ['m-1'],
      orientation: 'Tidying the auth flow.',
      mission: { goal: 'Big', context: [], constraints: [], acceptanceCriteria: [], assumptions: [] },
      briefs,
      approvedAt: null,
      approvedRevision: null
    }
    const built = context({ ravel: ravel({ plan }) })
    expect(built.promptChars).toBeLessThanOrEqual(MANAGER_CONTEXT_BUDGET.maxPromptChars)
    expect(built.prompt).toContain(`(+${300 - MANAGER_CONTEXT_BUDGET.maxPlanBriefLines} more briefs)`)
  })

  test('the capability secret never reaches the manager prompt', () => {
    expect(context().prompt).not.toContain('secret-value')
  })

  test('fleet state is one line per child, not transcripts', () => {
    const fleet: FleetSnapshot = {
      children: [
        { sessionId: 'child-1', briefId: 'brief-1', role: 'lead-engineer', status: 'running', ageSeconds: 42 }
      ]
    }
    const built = context({ fleet })
    expect(built.prompt).toContain('brief-1')
    expect(built.prompt).toContain('running')
  })

  test('the directive says what this turn is for and survives conversation shedding', () => {
    const messages = Array.from({ length: 12 }, (_, index) =>
      message({ id: `m-${index}`, body: 'y'.repeat(MANAGER_CONTEXT_BUDGET.maxMessageChars), createdAt: NOW + index })
    )
    const built = context({ ravel: ravel({ messages }), directive: 'CHILD EXIT: brief-1 completed' })
    expect(built.prompt).toContain('CHILD EXIT: brief-1 completed')
    expect(built.promptChars).toBeLessThanOrEqual(MANAGER_CONTEXT_BUDGET.maxPromptChars)
  })

  test('previous tool results are carried back, clipped, and never unbounded', () => {
    const built = context({ toolResults: ['{"ok":false,"error":{"code":"plan-required"}}', 'z'.repeat(50_000)] })
    expect(built.prompt).toContain('plan-required')
    expect(built.promptChars).toBeLessThanOrEqual(MANAGER_CONTEXT_BUDGET.maxPromptChars)
  })
})

describe('parseToolCalls', () => {
  test('extracts a fenced tool call from clean output', () => {
    const out = 'chatter\n```conductor-tool\n{"tool":"reply","body":"hi"}\n```\nmore'
    expect(parseToolCalls(out)).toEqual([{ tool: 'reply', body: 'hi' }])
  })

  test('survives ANSI colour and cursor sequences around the fence', () => {
    const out =
      '\u001b[32m\u001b[1mthinking\u001b[0m\n\u001b[?25l```conductor-tool\n' +
      '{"tool":"propose_plan","sourceMessageIds":["m-1"]}\n```\u001b[?25h\n'
    expect(parseToolCalls(out)).toEqual([{ tool: 'propose_plan', sourceMessageIds: ['m-1'] }])
  })

  test('malformed JSON is skipped rather than throwing', () => {
    const out = '```conductor-tool\n{not json}\n```\n```conductor-tool\n{"tool":"log","text":"ok"}\n```'
    expect(parseToolCalls(out)).toEqual([{ tool: 'log', text: 'ok' }])
  })

  test('multiple calls are returned in order', () => {
    const out =
      '```conductor-tool\n{"tool":"log","text":"one"}\n```\n' +
      '```conductor-tool\n{"tool":"log","text":"two"}\n```'
    expect(parseToolCalls(out).map((call) => call.text)).toEqual(['one', 'two'])
  })

  test('output with no fenced block yields nothing', () => {
    expect(parseToolCalls('I will now think about it.')).toEqual([])
  })
})
