import { RAVEL_BRIEF_PHASES, type HarnessId, type RavelConfig, type RavelMessage } from '@shared/types'

/**
 * Prompt construction for one on-demand manager turn.
 *
 * The manager is no longer a live session holding unbounded context, so every
 * turn rebuilds its prompt from scratch. These caps are the whole point of the
 * design: without them the "cheap" per-turn manager silently grows back into
 * the expensive persistent one.
 */
export const MANAGER_CONTEXT_BUDGET = {
  maxPromptChars: 12_000,
  maxConversationChars: 6_000,
  maxMessages: 12,
  maxMessageChars: 1_500,
  maxDirectiveChars: 2_000,
  maxToolResultChars: 1_200,
  maxPlanBriefLines: 40,
  /** Plan source messages always ride along, however old they are. */
  maxPinnedSources: 4,
  /** Per mission array (constraints / acceptance criteria / assumptions). */
  maxMissionEntries: 8,
  maxMissionEntryChars: 200
} as const

export interface FleetChild {
  sessionId: string
  briefId: string | null
  role: string
  status: string
  ageSeconds: number
}

export interface FleetSnapshot {
  children: FleetChild[]
}

export interface ManagerContextInput {
  ravel: RavelConfig
  fleet: FleetSnapshot
  /** Why this turn is happening: the framed user message, approval, retry, or child event. */
  directive: string
  /** Harness ids a brief may actually be assigned to; anything else fails validation. */
  availableHarnesses: HarnessId[]
  /** Results of the previous batch inside this same trigger, when re-invoking. */
  toolResults?: string[]
}

export interface ManagerContext {
  prompt: string
  promptChars: number
  includedMessages: number
}

export type ToolCall = { tool?: string } & Record<string, unknown>

const SYSTEM_PROMPT = [
  'You are Ravel, an orchestration manager for parallel coding sessions.',
  'You decompose work and delegate; you never edit files yourself.',
  '',
  '=== HOW YOU RUN ===',
  'You are invoked once per event, with no memory between invocations: this',
  'prompt is the whole of your context. Do all the work for this event now.',
  '',
  '=== TOOL PROTOCOL ===',
  'Reply with one or more fenced blocks using the language `conductor-tool`,',
  'each containing exactly one JSON object. Emit nothing else of consequence.',
  'Conductor runs them in order and this invocation then ends, so batch every',
  'call the event needs (for example one spawn_child per ready brief).',
  'Tools:',
  '- reply {"tool":"reply","body":"message to the user"}',
  '- ask_clarification {"tool":"ask_clarification","question":"question for the user","options":["choice","other choice"]}',
  '- propose_plan {"tool":"propose_plan","sourceMessageIds":["message-id"],"orientation":"one or two sentences","mission":{...},"briefs":[...]}',
  '- spawn_child {"tool":"spawn_child","briefId":"approved-brief-id"}',
  '- message_child {"tool":"message_child","childId":"session-id","body":"directive"}',
  '- get_status {"tool":"get_status"}',
  '- log {"tool":"log","level":"info|action|warn|error","text":"user-visible log"}',
  '- complete {"tool":"complete","summary":"one-line outcome"}',
  '',
  '=== RULES ===',
  '- Children receive only their own brief. Write briefs that stand alone.',
  '- List exact files in relevantContext so a child never searches the repo.',
  '- spawn_child takes only briefId, and only after the user approves a plan.',
  '- Ask for clarification instead of guessing at an ambiguous request.',
  '- Offer options only when the answer is a genuinely closed set — at most five,',
  '  a few words each. Leave options out for anything open-ended; the user can',
  '  always type instead, and a fake menu is worse than a plain question.',
  '- propose_plan must cite the conversation message ids it came from.',
  '- Call complete only once every brief in the approved plan has completed.',
  '',
  '=== SIZE THE PLAN TO THE WORK ===',
  'Fan-out is a cost, not a virtue. Use one brief when one agent can do the job;',
  'split only where the work genuinely divides and the parts can proceed apart.',
  'Never add a brief to look thorough. A one-file change is one brief.',
  'Detail scales the same way. Fill in an array when you have something real to',
  'say and leave it empty when you do not — inventing acceptance criteria or',
  'escalation conditions for trivial work is worse than omitting them.',
  '',
  '=== PLAN SHAPE ===',
  'A rejected proposal is retried at most three times before the Ravel errors out.',
  'orientation: one or two sentences, shared verbatim with every child. Say what',
  '  the overall effort is in the plainest terms so an agent knows what it is part',
  '  of. Never put the mission, another brief, or the user\'s words in it.',
  'mission: { goal: string, context: string[], constraints: string[],',
  '           acceptanceCriteria: string[], assumptions: string[] }',
  'brief:   { id: string, title: string, role: "lead-engineer"|"auditor"|"minor-task",',
  '           harness: one of the available harnesses listed under RUNTIME,',
  `           model: string|null, phase: ${RAVEL_BRIEF_PHASES.map((phase) => `"${phase}"`).join('|')},`,
  '           goal: string, relevantContext: string[], constraints: string[],',
  '           acceptanceCriteria: string[], doNotTouch: string[], expectedOutput: string,',
  '           escalationConditions: string[], dependsOn: string[] }',
  'Required on every brief: id, title, goal, expectedOutput. The arrays may be',
  'empty. dependsOn must name brief ids from this same proposal.',
  'One exception: if the plan has more than one brief, every brief must carry',
  'real doNotTouch entries, because that is what keeps parallel agents apart.'
].join('\n')

function clip(value: string, limit: number): string {
  const trimmed = value.trim()
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}…`
}

/**
 * Recency window, plus the messages the current plan was built from.
 *
 * The pinned sources are the user's own words behind the ratified plan. The
 * store already refuses to evict them (`trimMessages`); dropping them here for
 * being old is how a long-running fleet drifts off the thing it was asked to do.
 */
function conversationSlice(
  messages: RavelMessage[],
  plan: RavelConfig['plan']
): { lines: string[]; included: number } {
  const pinnedIds = new Set((plan?.sourceMessageIds ?? []).slice(0, MANAGER_CONTEXT_BUDGET.maxPinnedSources))
  const chosen: RavelMessage[] = []
  let used = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (chosen.length >= MANAGER_CONTEXT_BUDGET.maxMessages) break
    const body = clip(messages[index].body, MANAGER_CONTEXT_BUDGET.maxMessageChars)
    if (used + body.length > MANAGER_CONTEXT_BUDGET.maxConversationChars && chosen.length > 0) break
    chosen.push({ ...messages[index], body })
    used += body.length
  }
  chosen.reverse()

  const recentIds = new Set(chosen.map((message) => message.id))
  const pinned = messages
    .filter((message) => pinnedIds.has(message.id) && !recentIds.has(message.id))
    .map((message) => ({ ...message, body: clip(message.body, MANAGER_CONTEXT_BUDGET.maxMessageChars) }))

  const render = (message: RavelMessage, isPinned: boolean): string =>
    `${isPinned ? 'PINNED ' : ''}${message.author.toUpperCase()}: ${message.body}`
  return {
    lines: [...pinned.map((message) => render(message, true)), ...chosen.map((message) => render(message, false))],
    included: pinned.length + chosen.length
  }
}

/**
 * The plan as the manager needs to act on it: what was ratified, what each
 * brief is, what it is waiting on, and where its dispatch stands.
 *
 * The mission arrays are the intent the user actually approved, so they ride
 * every turn — a manager that only sees `goal` will happily violate a
 * constraint it agreed to ten minutes ago. Brief *bodies* still never appear.
 */
function planDigest(plan: RavelConfig['plan'], dispatches: RavelConfig['dispatches']): string[] {
  if (!plan) return ['(no plan yet)']
  const approved = plan.approvedRevision === plan.revision ? 'approved' : 'unapproved'
  const lines = [`revision ${plan.revision} (${approved})`, `goal: ${clip(plan.mission.goal, 300)}`]
  for (const [label, entries] of [
    ['constraints', plan.mission.constraints],
    ['acceptance criteria', plan.mission.acceptanceCriteria],
    ['assumptions', plan.mission.assumptions]
  ] as const) {
    for (const entry of entries.slice(0, MANAGER_CONTEXT_BUDGET.maxMissionEntries)) {
      lines.push(`${label}: ${clip(entry, MANAGER_CONTEXT_BUDGET.maxMissionEntryChars)}`)
    }
  }
  const shown = plan.briefs.slice(0, MANAGER_CONTEXT_BUDGET.maxPlanBriefLines)
  for (const brief of shown) {
    const dispatch = dispatches.find(
      (record) => record.briefId === brief.id && record.planRevision === plan.revision
    )
    // dependsOn decides what may spawn next, which is the whole question on a
    // child-exit turn; without it the manager is guessing at its own plan.
    const waits = brief.dependsOn.length === 0 ? '' : ` ← ${brief.dependsOn.join(', ')}`
    lines.push(
      `- ${brief.id} [${brief.role}/${brief.harness}] ${clip(brief.title, 80)} · ${dispatch?.status ?? 'not dispatched'}${waits}`
    )
  }
  // The digest is part of the fixed head, so it has to be bounded too: an
  // unbounded plan would push the prompt over the cap with nothing sheddable.
  if (plan.briefs.length > shown.length) lines.push(`(+${plan.briefs.length - shown.length} more briefs)`)
  return lines
}

function fleetDigest(fleet: FleetSnapshot): string[] {
  if (fleet.children.length === 0) return ['(no live children)']
  return fleet.children.map(
    (child) => `- ${child.briefId ?? '(no brief)'} [${child.role}] ${child.status} · ${child.ageSeconds}s`
  )
}

export function buildManagerContext(input: ManagerContextInput): ManagerContext {
  const conversation = conversationSlice(input.ravel.messages, input.ravel.plan)
  const results = (input.toolResults ?? []).map((result) =>
    clip(result, MANAGER_CONTEXT_BUDGET.maxToolResultChars)
  )
  const head = [
    SYSTEM_PROMPT,
    '',
    '=== RUNTIME ===',
    `repository: ${input.ravel.repoPath}`,
    'status: ' + input.ravel.status + '; child scheduling: adaptive internal capacity',
    `available harnesses: ${input.availableHarnesses.join(', ') || '(none)'}`,
    '',
    '=== CURRENT PLAN ===',
    ...planDigest(input.ravel.plan, input.ravel.dispatches),
    '',
    '=== FLEET ===',
    ...fleetDigest(input.fleet),
    '',
    '=== CONVERSATION ==='
  ]
  const tail = [
    '',
    '=== THIS TURN ===',
    clip(input.directive, MANAGER_CONTEXT_BUDGET.maxDirectiveChars),
    ...(results.length === 0 ? [] : ['', '=== RESULTS OF YOUR PREVIOUS CALLS ===', ...results])
  ]

  // The conversation is the only sheddable slice: the plan, the fleet and the
  // directive are what the turn is about. Drop the oldest lines until it fits.
  let lines = conversation.lines
  let prompt = [...head, ...lines, ...tail].join('\n')
  while (prompt.length > MANAGER_CONTEXT_BUDGET.maxPromptChars && lines.length > 0) {
    lines = lines.slice(1)
    prompt = [...head, ...lines, ...tail].join('\n')
  }
  if (prompt.length > MANAGER_CONTEXT_BUDGET.maxPromptChars) {
    // Fail loudly rather than silently truncating: a head this big means a cap
    // above regressed, and quietly trimming is how "cheap" turns get expensive.
    throw new Error(
      `manager prompt is ${prompt.length} chars with no conversation left to shed (cap ${MANAGER_CONTEXT_BUDGET.maxPromptChars})`
    )
  }

  return {
    prompt,
    promptChars: prompt.length,
    includedMessages: lines.length
  }
}

// CSI/OSC sequences from TUI harnesses would otherwise split fenced blocks.
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g
const TOOL_RE = /```conductor-tool[ \t]*\r?\n([\s\S]*?)```/g

export function stripAnsi(value: string): string {
  return value.replace(ANSI_RE, '')
}

export function parseToolCalls(stdout: string): ToolCall[] {
  const clean = stripAnsi(stdout)
  const calls: ToolCall[] = []
  for (const match of clean.matchAll(TOOL_RE)) {
    try {
      const parsed: unknown = JSON.parse(match[1].trim())
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        calls.push(parsed as ToolCall)
      }
    } catch {
      // A malformed block is the model's error, not a crash for the runtime.
    }
  }
  return calls
}
