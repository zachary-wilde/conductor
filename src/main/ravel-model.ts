import type {
  ChildRavelRole,
  HarnessAvailability,
  HarnessId,
  RavelBrief,
  RavelConfig,
  RavelDispatchRecord,
  RavelPlan
} from '@shared/types'
import { RAVEL_BRIEF_PHASES } from '@shared/types'

export type ValidationError = {
  code: string
  message: string
  field?: string
  briefId?: string
  dependencyId?: string
}

export type StaleRevisionError = {
  code: 'stale-revision'
  currentRevision: number | null
  requestedRevision: number
}

export type TranscriptValidationResult =
  | { ok: true; body: string }
  | { ok: false; error: { code: string; message: string } }

export function validateTranscriptContent(body: string): TranscriptValidationResult {
  const trimmed = body.trim()
  if (trimmed.length === 0) {
    return { ok: false, error: { code: 'message-body-required', message: 'Message body is required.' } }
  }
  if (trimmed.length > 16_000) {
    return {
      ok: false,
      error: { code: 'message-body-too-long', message: 'Message body must be 16,000 characters or fewer.' }
    }
  }
  return { ok: true, body: trimmed }
}

export type PlanValidationResult =
  | { ok: true; plan: RavelPlan }
  | { ok: false; errors: ValidationError[] }

export type PlanMutationResult =
  | { ok: true; plan: RavelPlan }
  | { ok: false; error: ValidationError | StaleRevisionError }

export type ApprovalResult = PlanMutationResult

export type SpawnEligibilityResult =
  | { ok: true; brief: RavelBrief }
  | { ok: false; error: ValidationError | StaleRevisionError }

export type ResumeInterruptedBriefResult =
  | { ok: true; dispatch: RavelDispatchRecord; branch: string; worktreePath: string }
  | { ok: false; error: ValidationError | StaleRevisionError }

/**
 * Two lines is the ceiling on purpose. This string is handed to every child, so
 * an unbounded one would quietly become the mission and undo the whole point of
 * writing separate briefs.
 */
export const MAX_ORIENTATION_CHARS = 240

export function clipOrientation(value: unknown): string {
  if (typeof value !== 'string') return ''
  const flat = value.trim().replace(/\s+/g, ' ')
  return flat.length <= MAX_ORIENTATION_CHARS ? flat : `${flat.slice(0, MAX_ORIENTATION_CHARS - 1)}…`
}

export type ValidatePlanProposalInput = {
  proposal: {
    sourceMessageIds: string[]
    orientation: string
    mission: RavelPlan['mission']
    briefs: RavelBrief[]
  }
  previousPlan: RavelPlan | null
  now: number
  fullContextChars: number
  harnessAvailability: Record<HarnessId, HarnessAvailability>
}

export type CanSpawnBriefInput = {
  briefId: string
  planRevision: number
  fullContextChars: number
  harnessAvailability: Record<HarnessId, HarnessAvailability>
}

export type CanResumeInterruptedBriefInput = {
  briefId: string
  planRevision: number
}

export type BuildRolePromptInput = {
  brief: RavelBrief
  dependencyOutputs?: Partial<Record<string, string>>
}

export type ApplyBriefAssignmentInput = {
  planRevision: number
  briefId: string
  assignment: {
    role?: ChildRavelRole
    harness?: HarnessId
    /** Explicit null clears the override; a string sets it. */
    model?: string | null
  }
  now: number
  fullContextChars: number
  harnessAvailability: Record<HarnessId, HarnessAvailability>
}

const CHILD_ROLES: Record<ChildRavelRole, true> = {
  'lead-engineer': true,
  auditor: true,
  'minor-task': true,
  researcher: true,
  'test-engineer': true,
  'security-engineer': true,
  'performance-engineer': true,
  'release-engineer': true
}
const LIVE_DISPATCH_STATUSES: Record<RavelDispatchRecord['status'], boolean> = {
  starting: true,
  active: true,
  completed: false,
  failed: false,
  interrupted: false,
  detached: false
}

export function validatePlanProposal(input: ValidatePlanProposalInput): PlanValidationResult {
  return createPlanRevision(input)
}

export function createPlanRevision(input: ValidatePlanProposalInput): PlanValidationResult {
  const errors = validateProposal(input)
  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    plan: {
      revision: (input.previousPlan?.revision ?? 0) + 1,
      createdAt: input.now,
      sourceMessageIds: input.proposal.sourceMessageIds.slice(),
      orientation: clipOrientation(input.proposal.orientation),
      mission: copyMission(input.proposal.mission),
      briefs: input.proposal.briefs.map(copyBrief),
      approvedAt: null,
      approvedRevision: null
    }
  }
}

export function approveCurrentPlan(
  ravel: RavelConfig,
  input: { planRevision: number; now: number }
): ApprovalResult {
  const plan = ravel.plan
  if (plan === null) return resultError('plan-required', 'A plan is required before approval.')
  const stale = staleRevision(plan, input.planRevision)
  if (stale) return { ok: false, error: stale }

  return { ok: true, plan: { ...plan, approvedAt: input.now, approvedRevision: input.planRevision } }
}

export function applyBriefAssignmentToPlan(
  ravel: RavelConfig,
  input: ApplyBriefAssignmentInput
): PlanMutationResult {
  const plan = ravel.plan
  if (plan === null) return resultError('plan-required', 'A plan is required before assignment.')
  const stale = staleRevision(plan, input.planRevision)
  if (stale) return { ok: false, error: stale }

  const index = plan.briefs.findIndex((brief) => brief.id === input.briefId)
  if (index === -1) return resultError('brief-not-found', 'The requested brief does not exist.')

  const assignedRole = input.assignment.role
  if (assignedRole !== undefined && !isChildRavelRole(assignedRole)) {
    return resultError('brief-role-invalid', 'Child briefs must use a specialist role.', 'role', input.briefId)
  }

  const assignedHarness = input.assignment.harness
  if (assignedHarness !== undefined && !isHarnessAvailable(input.harnessAvailability, assignedHarness)) {
    return resultError(
      'brief-harness-unavailable',
      'The assigned harness is not available.',
      'harness',
      input.briefId
    )
  }

  const assignedModel = input.assignment.model
  if (assignedModel !== undefined && assignedModel !== null && assignedModel.trim().length === 0) {
    return resultError('brief-model-invalid', 'Model override cannot be blank; clear it instead.', 'model', input.briefId)
  }

  const currentBrief = plan.briefs[index]
  const nextBrief = {
    ...currentBrief,
    role: assignedRole ?? currentBrief.role,
    harness: assignedHarness ?? currentBrief.harness,
    model: assignedModel === undefined ? currentBrief.model : assignedModel === null ? null : assignedModel.trim()
  }
  const contextError = contextExceptionError(nextBrief, input.fullContextChars)
  if (contextError) return { ok: false, error: contextError }

  const briefs = plan.briefs.slice()
  briefs[index] = nextBrief

  return {
    ok: true,
    plan: {
      ...plan,
      revision: plan.revision + 1,
      createdAt: input.now,
      briefs,
      approvedAt: null,
      approvedRevision: null
    }
  }
}

export function canSpawnBrief(ravel: RavelConfig, input: CanSpawnBriefInput): SpawnEligibilityResult {
  const plan = ravel.plan
  if (plan === null) return resultError('plan-required', 'A plan is required before spawning a brief.')
  const stale = staleRevision(plan, input.planRevision)
  if (stale) return { ok: false, error: stale }
  if (plan.approvedRevision !== plan.revision || plan.approvedAt === null) {
    return resultError('plan-approval-required', 'The current plan revision must be approved before spawning.')
  }
  if (ravel.status !== 'running') {
    return resultError('ravel-not-running', 'Ravel must be running before spawning briefs.')
  }

  const brief = plan.briefs.find((candidate) => candidate.id === input.briefId)
  if (brief === undefined) return resultError('brief-not-found', 'The requested brief does not exist.')

  const completed = completedDispatchIds(ravel.dispatches, plan.revision)
  for (let i = 0; i < brief.dependsOn.length; i += 1) {
    if (!completed.has(brief.dependsOn[i])) {
      return resultError('brief-dependencies-unmet', 'All brief dependencies must complete before spawning.')
    }
  }

  const sameRevisionDispatch = blockingSameRevisionDispatch(ravel.dispatches, brief.id, plan.revision)
  if (sameRevisionDispatch === 'completed') {
    return resultError('brief-already-completed', 'The requested brief already completed for this plan revision.')
  }
  if (sameRevisionDispatch === 'interrupted') {
    return resultError('brief-interrupted-requires-resume', 'Interrupted dispatches must be resumed, not spawned again.')
  }
  if (sameRevisionDispatch === 'live') {
    return resultError('brief-already-live', 'The requested brief already has a live dispatch.')
  }
  if (!isHarnessAvailable(input.harnessAvailability, brief.harness)) {
    return resultError('brief-harness-unavailable', 'The requested brief harness is not available.')
  }

  const contextError = contextExceptionError(brief, input.fullContextChars)
  if (contextError) return { ok: false, error: contextError }

  return { ok: true, brief }
}

export function canResumeInterruptedBrief(
  ravel: RavelConfig,
  input: CanResumeInterruptedBriefInput
): ResumeInterruptedBriefResult {
  const plan = ravel.plan
  if (plan === null) return resultError('plan-required', 'A plan is required before resuming a brief.')
  const stale = staleRevision(plan, input.planRevision)
  if (stale) return { ok: false, error: stale }
  if (plan.approvedRevision !== plan.revision || plan.approvedAt === null) {
    return resultError('plan-approval-required', 'The current plan revision must be approved before resuming.')
  }
  if (ravel.status !== 'running') {
    return resultError('ravel-not-running', 'Ravel must be running before resuming briefs.')
  }

  const dispatch = ravel.dispatches.find(
    (candidate) =>
      candidate.briefId === input.briefId &&
      candidate.planRevision === input.planRevision &&
      candidate.status === 'interrupted'
  )
  if (dispatch === undefined) {
    return resultError('interrupted-dispatch-not-found', 'An interrupted dispatch is required before resuming.')
  }

  return { ok: true, dispatch, branch: dispatch.branch, worktreePath: dispatch.worktreePath }
}

export function buildRolePrompt(input: BuildRolePromptInput): string {
  const dependencyOutputs = input.dependencyOutputs ?? {}
  const brief = input.brief
  const sections = [
    `ROLE: ${ravelRoleLabel(brief.role)}`,
    `GOAL:\n${brief.goal}`,
    `RELEVANT CONTEXT:\n${formatList(brief.relevantContext)}`,
    `CONSTRAINTS:\n${formatList(brief.constraints)}`,
    `ACCEPTANCE CRITERIA:\n${formatList(brief.acceptanceCriteria)}`,
    `DO NOT TOUCH:\n${formatList(brief.doNotTouch)}`,
    `EXPECTED OUTPUT:\n${brief.expectedOutput}`,
    `ESCALATION:\n${formatList(brief.escalationConditions)}`
  ]

  const explicitOutputs = brief.dependsOn
    .map((id) => {
      const output = dependencyOutputs[id]
      return isNonEmptyString(output) ? `- ${id}: ${output.trim()}` : null
    })
    .filter((line): line is string => line !== null)

  if (explicitOutputs.length > 0) sections.push(`DEPENDENCY OUTPUTS:\n${explicitOutputs.join('\n')}`)

  return sections.join('\n\n')
}

export function interruptLiveDispatchesForRestart(ravel: RavelConfig): RavelConfig {
  return {
    ...ravel,
    status: 'paused',
    managerSessionId: null,
    dispatches: ravel.dispatches.map((dispatch) =>
      LIVE_DISPATCH_STATUSES[dispatch.status] ? { ...dispatch, status: 'interrupted' } : dispatch
    )
  }
}

export function ravelRoleLabel(role: ChildRavelRole | 'orchestrator'): string {
  switch (role) {
    case 'orchestrator':
      return 'Reigen'
    case 'lead-engineer':
      return 'Lead Engineer'
    case 'auditor':
      return 'Auditor'
    case 'minor-task':
      return 'Minor Task'
    case 'researcher':
      return 'Researcher'
    case 'test-engineer':
      return 'Test Engineer'
    case 'security-engineer':
      return 'Security Engineer'
    case 'performance-engineer':
      return 'Performance Engineer'
    case 'release-engineer':
      return 'Release Engineer'
  }
}

export function isHarnessAvailable(
  harnessAvailability: Record<HarnessId, HarnessAvailability>,
  harness: HarnessId
): boolean {
  return harnessAvailability[harness]?.available === true
}

function copyMission(mission: RavelPlan['mission']): RavelPlan['mission'] {
  return {
    goal: mission.goal,
    context: mission.context.slice(),
    constraints: mission.constraints.slice(),
    acceptanceCriteria: mission.acceptanceCriteria.slice(),
    assumptions: mission.assumptions.slice()
  }
}

function copyBrief(brief: RavelBrief): RavelBrief {
  return {
    ...brief,
    relevantContext: brief.relevantContext.slice(),
    constraints: brief.constraints.slice(),
    acceptanceCriteria: brief.acceptanceCriteria.slice(),
    doNotTouch: brief.doNotTouch.slice(),
    escalationConditions: brief.escalationConditions.slice(),
    dependsOn: brief.dependsOn.slice()
  }
}

function validateProposal(input: ValidatePlanProposalInput): ValidationError[] {
  const errors: ValidationError[] = []
  if (!hasNonEmptyArray(input.proposal.sourceMessageIds)) {
    errors.push(error('source-message-ids-required', 'At least one source message id is required.', 'sourceMessageIds'))
  }
  if (!isNonEmptyString(input.proposal.mission.goal)) {
    errors.push(error('mission-goal-required', 'A mission goal is required.', 'mission.goal'))
  }
  validateMissionArrays(errors, input.proposal.mission)
  if (!Array.isArray(input.proposal.briefs)) {
    errors.push(error('briefs-required', 'Briefs must be an array.', 'briefs'))
    return errors
  }

  const seenBriefIds = new Set<string>()
  for (let index = 0; index < input.proposal.briefs.length; index += 1) {
    const brief = input.proposal.briefs[index]
    const briefPath = `briefs.${index}`
    validateRequiredBriefFields(errors, brief, briefPath, input.proposal.briefs.length)

    const normalizedId = isNonEmptyString(brief.id) ? brief.id.trim() : ''
    if (!isChildRavelRole(brief.role)) {
      errors.push(error('brief-role-invalid', 'Child briefs must use a specialist role.', `${briefPath}.role`, normalizedId || undefined))
    }
    if (normalizedId !== '') {
      if (seenBriefIds.has(normalizedId)) {
        errors.push(error('brief-duplicate-id', 'Brief ids must be unique.', `${briefPath}.id`, normalizedId))
      } else {
        seenBriefIds.add(normalizedId)
      }
    }
    if (!isHarnessAvailable(input.harnessAvailability, brief.harness)) {
      errors.push(error('brief-harness-unavailable', 'The requested harness is not available.', `${briefPath}.harness`, normalizedId || undefined))
    }
    // The store refuses an unknown phase on write, which would surface as a
    // crashed turn rather than something the manager can fix. Caught here, it
    // becomes a tool result the next turn can act on.
    if (!RAVEL_BRIEF_PHASES.includes(brief.phase)) {
      errors.push(
        error(
          'brief-phase-invalid',
          `Brief phase must be one of: ${RAVEL_BRIEF_PHASES.join(', ')}.`,
          `${briefPath}.phase`,
          normalizedId || undefined
        )
      )
    }
  }

  validateDependencies(errors, input.proposal.briefs, seenBriefIds)
  for (let index = 0; index < input.proposal.briefs.length; index += 1) {
    const contextError = contextExceptionError(input.proposal.briefs[index], input.fullContextChars)
    if (contextError) errors.push(contextError)
  }

  return errors
}

/**
 * Detail is required in proportion to the work.
 *
 * A brief must always say who it is, what it is for, and what it produces —
 * without those there is nothing to dispatch. The elaboration arrays are
 * optional, because forcing acceptance criteria and escalation conditions onto
 * "make a hello page" makes the orchestrator invent specifications, and
 * invented specifications are the hallucination this project exists to stop.
 *
 * The one exception is `doNotTouch`, which is required as soon as a plan has
 * more than one brief: boundaries only matter when there is somebody else to
 * collide with, and then they matter a great deal.
 */
function validateRequiredBriefFields(
  errors: ValidationError[],
  brief: RavelBrief,
  briefPath: string,
  fanOut: number
): void {
  const id = isNonEmptyString(brief.id) ? brief.id.trim() : undefined
  if (!isNonEmptyString(brief.id)) errors.push(error('brief-id-required', 'A brief id is required.', `${briefPath}.id`))
  if (!isNonEmptyString(brief.title)) errors.push(error('brief-title-required', 'A brief title is required.', `${briefPath}.title`, id))
  if (!isNonEmptyString(brief.goal)) errors.push(error('brief-goal-required', 'A brief goal is required.', `${briefPath}.goal`, id))
  if (!isNonEmptyString(brief.expectedOutput)) {
    errors.push(error('brief-expected-output-required', 'Brief expected output is required.', `${briefPath}.expectedOutput`, id))
  }
  if (!hasStringArray(brief.relevantContext)) {
    errors.push(error('brief-relevant-context-invalid', 'Brief relevant context must be a string array.', `${briefPath}.relevantContext`, id))
  }
  if (!hasStringArray(brief.constraints)) {
    errors.push(error('brief-constraints-invalid', 'Brief constraints must be a string array.', `${briefPath}.constraints`, id))
  }
  if (!hasStringArray(brief.acceptanceCriteria)) {
    errors.push(error('brief-acceptance-criteria-invalid', 'Brief acceptance criteria must be a string array.', `${briefPath}.acceptanceCriteria`, id))
  }
  if (!hasStringArray(brief.escalationConditions)) {
    errors.push(error('brief-escalation-invalid', 'Brief escalation conditions must be a string array.', `${briefPath}.escalationConditions`, id))
  }
  if (!hasStringArray(brief.doNotTouch)) {
    errors.push(error('brief-do-not-touch-invalid', 'Brief do-not-touch must be a string array.', `${briefPath}.doNotTouch`, id))
  } else if (fanOut > 1 && brief.doNotTouch.length === 0) {
    errors.push(
      error(
        'brief-do-not-touch-required',
        'A plan with more than one brief must give each brief explicit do-not-touch boundaries.',
        `${briefPath}.doNotTouch`,
        id
      )
    )
  }
}

function validateMissionArrays(errors: ValidationError[], mission: RavelPlan['mission']): void {
  if (!hasStringArray(mission.context)) {
    errors.push(error('mission-context-required', 'Mission context must be a string array.', 'mission.context'))
  }
  if (!hasStringArray(mission.constraints)) {
    errors.push(error('mission-constraints-required', 'Mission constraints must be a string array.', 'mission.constraints'))
  }
  if (!hasStringArray(mission.acceptanceCriteria)) {
    errors.push(
      error(
        'mission-acceptance-criteria-required',
        'Mission acceptance criteria must be a string array.',
        'mission.acceptanceCriteria'
      )
    )
  }
  if (!hasStringArray(mission.assumptions)) {
    errors.push(error('mission-assumptions-required', 'Mission assumptions must be a string array.', 'mission.assumptions'))
  }
}

function validateDependencies(
  errors: ValidationError[],
  briefs: readonly RavelBrief[],
  knownIds: ReadonlySet<string>
): void {
  let dependenciesAreArrays = true
  for (let index = 0; index < briefs.length; index += 1) {
    const current = briefs[index]
    if (!hasStringArray(current.dependsOn)) {
      errors.push(error('brief-dependencies-invalid', 'Brief dependencies must be a string array.', `briefs.${index}.dependsOn`, current.id))
      dependenciesAreArrays = false
      continue
    }
    for (let dependencyIndex = 0; dependencyIndex < current.dependsOn.length; dependencyIndex += 1) {
      const dependencyId = current.dependsOn[dependencyIndex]
      if (!knownIds.has(dependencyId)) {
        errors.push(
          error('brief-dependency-unknown', 'Brief dependencies must refer to known brief ids.', `briefs.${index}.dependsOn`, current.id, dependencyId)
        )
      }
    }
  }

  if (dependenciesAreArrays && hasDependencyCycle(briefs)) {
    errors.push(error('brief-dependency-cycle', 'Brief dependencies cannot contain cycles.', 'briefs.dependsOn'))
  }
}
function hasDependencyCycle(briefs: readonly RavelBrief[]): boolean {
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const byId = new Map<string, RavelBrief>()
  for (let index = 0; index < briefs.length; index += 1) byId.set(briefs[index].id, briefs[index])

  for (let index = 0; index < briefs.length; index += 1) {
    if (visitBrief(briefs[index], byId, visiting, visited)) return true
  }
  return false
}

function visitBrief(
  brief: RavelBrief,
  byId: ReadonlyMap<string, RavelBrief>,
  visiting: Set<string>,
  visited: Set<string>
): boolean {
  if (visited.has(brief.id)) return false
  if (visiting.has(brief.id)) return true
  visiting.add(brief.id)
  for (let index = 0; index < brief.dependsOn.length; index += 1) {
    const dependency = byId.get(brief.dependsOn[index])
    if (dependency !== undefined && visitBrief(dependency, byId, visiting, visited)) return true
  }
  visiting.delete(brief.id)
  visited.add(brief.id)
  return false
}

function contextExceptionError(brief: RavelBrief, fullContextChars: number): ValidationError | null {
  if (serializedBriefContextLength(brief) < fullContextChars) return null
  if (isNonEmptyString(brief.contextExceptionReason)) return null
  return error(
    'brief-context-exception-required',
    'Brief context at or above full mission context size requires an exception reason.',
    'brief.contextExceptionReason',
    brief.id
  )
}

function serializedBriefContextLength(brief: RavelBrief): number {
  return JSON.stringify({
    relevantContext: brief.relevantContext,
    constraints: brief.constraints,
    acceptanceCriteria: brief.acceptanceCriteria,
    doNotTouch: brief.doNotTouch,
    expectedOutput: brief.expectedOutput,
    escalationConditions: brief.escalationConditions
  }).length
}

function completedDispatchIds(dispatches: readonly RavelDispatchRecord[], planRevision: number): Set<string> {
  const completed = new Set<string>()
  for (let index = 0; index < dispatches.length; index += 1) {
    const dispatch = dispatches[index]
    if (dispatch.planRevision === planRevision && dispatch.status === 'completed') completed.add(dispatch.briefId)
  }
  return completed
}

function blockingSameRevisionDispatch(
  dispatches: readonly RavelDispatchRecord[],
  briefId: string,
  planRevision: number
): 'completed' | 'interrupted' | 'live' | null {
  let hasInterrupted = false
  let hasLive = false
  for (let index = 0; index < dispatches.length; index += 1) {
    const dispatch = dispatches[index]
    if (dispatch.briefId !== briefId || dispatch.planRevision !== planRevision) continue
    if (dispatch.status === 'completed') return 'completed'
    if (dispatch.status === 'interrupted') hasInterrupted = true
    if (LIVE_DISPATCH_STATUSES[dispatch.status]) hasLive = true
  }
  if (hasInterrupted) return 'interrupted'
  if (hasLive) return 'live'
  return null
}


function staleRevision(plan: RavelPlan, requestedRevision: number): StaleRevisionError | null {
  return plan.revision === requestedRevision
    ? null
    : { code: 'stale-revision', currentRevision: plan.revision, requestedRevision }
}

function isChildRavelRole(role: string): role is ChildRavelRole {
  return CHILD_ROLES[role] === true
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function hasNonEmptyArray(values: unknown): values is string[] {
  if (!Array.isArray(values) || values.length === 0) return false
  for (let index = 0; index < values.length; index += 1) {
    if (!isNonEmptyString(values[index])) return false
  }
  return true
}

function hasStringArray(values: unknown): values is string[] {
  if (!Array.isArray(values)) return false
  for (let index = 0; index < values.length; index += 1) {
    if (!isNonEmptyString(values[index])) return false
  }
  return true
}

function formatList(values: readonly string[]): string {
  return values.map((value) => `- ${value}`).join('\n')
}

function resultError(
  code: string,
  message: string,
  field?: string,
  briefId?: string,
  dependencyId?: string
): { ok: false; error: ValidationError } {
  return { ok: false, error: error(code, message, field, briefId, dependencyId) }
}

function error(
  code: string,
  message: string,
  field?: string,
  briefId?: string,
  dependencyId?: string
): ValidationError {
  return { code, message, field, briefId, dependencyId }
}
