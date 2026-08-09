import { win32 } from 'node:path'
import type {
  ChildRavelRole,
  CreateNormalSessionRequest,
  CreateRoundtableRequest,
  CreateRavelRequest,
  HarnessId,
  RavelActionError,
  RavelActionResult,
  Repo,
  UpdateRavelBriefAssignmentRequest
} from '@shared/types'
import { MAX_ROUNDTABLE_SEATS, MIN_ROUNDTABLE_SEATS } from '@shared/types'

export type IpcValidation<T> = { ok: true; value: T } | { ok: false; error: RavelActionError }

const HARNESSES: Record<HarnessId, true> = { claude: true, codex: true, zai: true }
const CHILD_ROLES: Record<ChildRavelRole, true> = { 'lead-engineer': true, auditor: true, 'minor-task': true }
const MAX_CHILDREN: Record<number, true> = { 2: true, 4: true, 8: true, 16: true }
const SESSION_PRIVILEGED_FIELDS: Record<string, true> = {
  parentId: true,
  ravelId: true,
  ravelRole: true,
  briefId: true,
  autoApprove: true,
  env: true
}

export function invalidRavelRequest(error: RavelActionError): RavelActionResult {
  return { ok: false, error }
}

export function ravelReadFallback(kind: 'get'): null
export function ravelReadFallback(kind: 'log' | 'children'): []
export function ravelReadFallback(kind: 'get' | 'log' | 'children'): null | [] {
  return kind === 'get' ? null : []
}

function invalid(message: string): IpcValidation<never> {
  return { ok: false, error: { code: 'invalid-request', message } }
}

export function isIpcObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function own(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

function nonEmptyString(record: Record<string, unknown>, key: string): IpcValidation<string> {
  const value = record[key]
  if (typeof value !== 'string' || value.trim().length === 0) return invalid(`${key} must be a non-empty string.`)
  return { ok: true, value }
}

function optionalString(record: Record<string, unknown>, key: string): IpcValidation<string | undefined> {
  const value = record[key]
  if (value === undefined) return { ok: true, value: undefined }
  if (typeof value !== 'string') return invalid(`${key} must be a string.`)
  return { ok: true, value }
}

function optionalBoolean(record: Record<string, unknown>, key: string): IpcValidation<boolean | undefined> {
  const value = record[key]
  if (value === undefined) return { ok: true, value: undefined }
  if (typeof value !== 'boolean') return invalid(`${key} must be a boolean.`)
  return { ok: true, value }
}

function harness(value: unknown): IpcValidation<HarnessId> {
  if (typeof value !== 'string' || HARNESSES[value as HarnessId] !== true) {
    return invalid('harness must be one of claude, codex, or zai.')
  }
  return { ok: true, value: value as HarnessId }
}

/**
 * A plain session's agent, where null means "run the operator's shell".
 *
 * Deliberately separate from `harness()`: everything else that names a harness —
 * a ravel brief, a roundtable seat — must still be an agent the manager can
 * actually invoke, and would break if handed a shell.
 */
function sessionAgent(value: unknown): IpcValidation<HarnessId | null> {
  if (value === null) return { ok: true, value: null }
  return harness(value)
}

function childRole(value: unknown): IpcValidation<ChildRavelRole> {
  if (typeof value !== 'string' || CHILD_ROLES[value as ChildRavelRole] !== true) {
    return invalid('role must be one of lead-engineer, auditor, or minor-task.')
  }
  return { ok: true, value: value as ChildRavelRole }
}

function positiveSafeInteger(value: unknown, key: string): IpcValidation<number> {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) return invalid(`${key} must be a positive safe integer.`)
  return { ok: true, value: value as number }
}

function parseCreateWorktree(value: unknown): IpcValidation<CreateNormalSessionRequest['createWorktree']> {
  if (value === undefined) return { ok: true, value: undefined }
  if (!isIpcObject(value)) return invalid('createWorktree must be an object.')
  const repoPath = nonEmptyString(value, 'repoPath')
  if (!repoPath.ok) return repoPath
  const branch = nonEmptyString(value, 'branch')
  if (!branch.ok) return branch
  const baseBranch = optionalString(value, 'baseBranch')
  if (!baseBranch.ok) return baseBranch
  const newBranch = optionalBoolean(value, 'newBranch')
  if (!newBranch.ok) return newBranch
  return {
    ok: true,
    value: {
      repoPath: repoPath.value,
      branch: branch.value,
      ...(baseBranch.value === undefined ? {} : { baseBranch: baseBranch.value }),
      ...(newBranch.value === undefined ? {} : { newBranch: newBranch.value })
    }
  }
}

export function parseCreateNormalSessionRequest(payload: unknown): IpcValidation<CreateNormalSessionRequest> {
  if (!isIpcObject(payload)) return invalid('session create request must be an object.')
  for (const field of Object.keys(SESSION_PRIVILEGED_FIELDS)) {
    if (own(payload, field)) return invalid(`${field} is not allowed for public session creation.`)
  }
  if (payload.kind !== undefined && payload.kind !== 'normal') return invalid('kind must be normal when provided.')

  const repoId = nonEmptyString(payload, 'repoId')
  if (!repoId.ok) return repoId
  const repoPath = nonEmptyString(payload, 'repoPath')
  if (!repoPath.ok) return repoPath
  // When a worktree is created at launch, main fills the path in, so the
  // renderer legitimately sends an empty string here.
  const deferredWorktree = own(payload, 'createWorktree') && payload.createWorktree !== undefined
  if (typeof payload.worktreePath !== 'string' || (!deferredWorktree && payload.worktreePath.trim().length === 0)) {
    return invalid('worktreePath must be a non-empty string unless a worktree is created at launch.')
  }
  const worktreePath = { ok: true as const, value: payload.worktreePath }
  const branch = nonEmptyString(payload, 'branch')
  if (!branch.ok) return branch
  // Only a plain session may be a terminal. Ravel seats, roundtable seats and
  // brief assignments all go through `harness()`, which still refuses null.
  const selectedHarness = sessionAgent(payload.harness)
  if (!selectedHarness.ok) return selectedHarness
  const terminal = selectedHarness.value === null
  const initialPrompt = optionalString(payload, 'initialPrompt')
  if (!initialPrompt.ok) return initialPrompt
  if (terminal && initialPrompt.value !== undefined) {
    return invalid('a terminal session takes no initial prompt: a shell would execute it.')
  }
  const model = optionalString(payload, 'model')
  if (!model.ok) return model
  if (terminal && model.value !== undefined) return invalid('a terminal session takes no model.')
  if (model.value !== undefined && model.value.trim().length === 0) return invalid('model must be a non-empty string when provided.')
  const createWorktree = parseCreateWorktree(payload.createWorktree)
  if (!createWorktree.ok) return createWorktree

  return {
    ok: true,
    value: {
      repoId: repoId.value,
      repoPath: repoPath.value,
      worktreePath: worktreePath.value,
      branch: branch.value,
      harness: selectedHarness.value,
      ...(initialPrompt.value === undefined ? {} : { initialPrompt: initialPrompt.value }),
      ...(model.value === undefined ? {} : { model: model.value.trim() }),
      ...(createWorktree.value === undefined ? {} : { createWorktree: createWorktree.value }),
      ...(payload.kind === 'normal' ? { kind: 'normal' as const } : {})
    }
  }
}

function windowsIdentity(path: string): string {
  return win32.normalize(path).replace(/[\\/]+$/, '').toLowerCase()
}

export function parseCreateRavelRequest(payload: unknown, repos: Repo[]): IpcValidation<CreateRavelRequest> {
  if (!isIpcObject(payload)) return invalid('ravel create request must be an object.')
  const name = nonEmptyString(payload, 'name')
  if (!name.ok) return name
  const repoId = nonEmptyString(payload, 'repoId')
  if (!repoId.ok) return repoId
  const repoPath = nonEmptyString(payload, 'repoPath')
  if (!repoPath.ok) return repoPath
  const selectedHarness = harness(payload.harness)
  if (!selectedHarness.ok) return selectedHarness

  const repo = repos.find((candidate) => candidate.id === repoId.value)
  if (!repo) return invalid('repoId does not refer to a tracked repository.')
  if (windowsIdentity(repo.path) !== windowsIdentity(repoPath.value)) {
    return invalid('repoPath must match the tracked repository path.')
  }

  const initialInstruction = optionalString(payload, 'initialInstruction')
  if (!initialInstruction.ok) return initialInstruction
  const allowRisky = optionalBoolean(payload, 'allowRisky')
  if (!allowRisky.ok) return allowRisky
  if (payload.maxChildren !== undefined && (!Number.isSafeInteger(payload.maxChildren) || MAX_CHILDREN[payload.maxChildren as number] !== true)) {
    return invalid('maxChildren must be one of 2, 4, 8, or 16.')
  }
  const model = optionalString(payload, 'model')
  if (!model.ok) return model
  if (model.value !== undefined && model.value.trim().length === 0) return invalid('model must be a non-empty string when provided.')

  return {
    ok: true,
    value: {
      name: name.value,
      repoId: repo.id,
      repoPath: repo.path,
      harness: selectedHarness.value,
      ...(model.value === undefined ? {} : { model: model.value.trim() }),
      ...(initialInstruction.value === undefined ? {} : { initialInstruction: initialInstruction.value }),
      ...(payload.maxChildren === undefined ? {} : { maxChildren: payload.maxChildren as number }),
      ...(allowRisky.value === undefined ? {} : { allowRisky: allowRisky.value })
    }
  }
}

/**
 * A roundtable takes no worktree and writes nothing, but it still spends
 * quota, so the repository and every seat's harness are checked here rather
 * than trusted from the renderer.
 */
export function parseCreateRoundtableRequest(
  payload: unknown,
  repos: Repo[]
): IpcValidation<CreateRoundtableRequest> {
  if (!isIpcObject(payload)) return invalid('roundtable create request must be an object.')
  const name = nonEmptyString(payload, 'name')
  if (!name.ok) return name
  const repoId = nonEmptyString(payload, 'repoId')
  if (!repoId.ok) return repoId
  const topic = nonEmptyString(payload, 'topic')
  if (!topic.ok) return topic
  const repo = repos.find((candidate) => candidate.id === repoId.value)
  if (!repo) return invalid('repoId does not refer to a tracked repository.')
  if (!Array.isArray(payload.seats)) return invalid('seats must be an array.')
  if (payload.seats.length < MIN_ROUNDTABLE_SEATS || payload.seats.length > MAX_ROUNDTABLE_SEATS) {
    return invalid(`a roundtable seats ${MIN_ROUNDTABLE_SEATS} to ${MAX_ROUNDTABLE_SEATS} models.`)
  }
  const seats: CreateRoundtableRequest['seats'] = []
  for (const [index, seat] of payload.seats.entries()) {
    if (!isIpcObject(seat)) return invalid(`seat ${index + 1} must be an object.`)
    const seatHarness = harness(seat.harness)
    if (!seatHarness.ok) return invalid(`seat ${index + 1}: ${seatHarness.error}`)
    const seatName = optionalString(seat, 'name')
    if (!seatName.ok) return seatName
    const stance = optionalString(seat, 'stance')
    if (!stance.ok) return stance
    // `null` is the documented way to say "whatever the harness defaults to",
    // so it is a value here, not a missing field.
    const model = seat.model === null ? { ok: true as const, value: undefined } : optionalString(seat, 'model')
    if (!model.ok) return model
    seats.push({
      name: seatName.value ?? `Seat ${index + 1}`,
      harness: seatHarness.value,
      model: model.value === undefined || model.value.trim().length === 0 ? null : model.value.trim(),
      stance: stance.value ?? ''
    })
  }
  if (payload.maxTurns !== undefined && !Number.isSafeInteger(payload.maxTurns)) {
    return invalid('maxTurns must be a whole number.')
  }
  return {
    ok: true,
    value: {
      name: name.value,
      repoId: repo.id,
      repoPath: repo.path,
      topic: topic.value,
      seats,
      ...(payload.maxTurns === undefined ? {} : { maxTurns: payload.maxTurns as number })
    }
  }
}

export function parseRavelId(id: unknown): IpcValidation<string> {
  if (typeof id !== 'string' || id.trim().length === 0) return invalid('id must be a non-empty string.')
  return { ok: true, value: id }
}

export function parseRavelMessage(id: unknown, body: unknown): IpcValidation<{ id: string; body: string }> {
  const parsedId = parseRavelId(id)
  if (!parsedId.ok) return parsedId
  if (typeof body !== 'string' || body.trim().length === 0) return invalid('body must be a non-empty string.')
  return { ok: true, value: { id: parsedId.value, body } }
}

export function parseRavelSteer(
  id: unknown,
  sessionId: unknown,
  note: unknown
): IpcValidation<{ id: string; sessionId: string; note: string }> {
  const parsed = parseRavelMessage(id, note)
  if (!parsed.ok) return parsed
  if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
    return invalid('sessionId must be a non-empty string.')
  }
  return { ok: true, value: { id: parsed.value.id, sessionId, note: parsed.value.body } }
}

export function parseRavelPlanRevision(id: unknown, planRevision: unknown): IpcValidation<{ id: string; planRevision: number }> {
  const parsedId = parseRavelId(id)
  if (!parsedId.ok) return parsedId
  const parsedRevision = positiveSafeInteger(planRevision, 'planRevision')
  if (!parsedRevision.ok) return parsedRevision
  return { ok: true, value: { id: parsedId.value, planRevision: parsedRevision.value } }
}

export function parseRavelPlanMessage(
  id: unknown,
  planRevision: unknown,
  body: unknown
): IpcValidation<{ id: string; planRevision: number; body: string }> {
  const parsed = parseRavelPlanRevision(id, planRevision)
  if (!parsed.ok) return parsed
  if (typeof body !== 'string' || body.trim().length === 0) return invalid('body must be a non-empty string.')
  return { ok: true, value: { ...parsed.value, body } }
}

export function parseRavelBriefMutation(
  id: unknown,
  planRevision: unknown,
  briefId: unknown
): IpcValidation<{ id: string; planRevision: number; briefId: string }> {
  const parsed = parseRavelPlanRevision(id, planRevision)
  if (!parsed.ok) return parsed
  if (typeof briefId !== 'string' || briefId.trim().length === 0) return invalid('briefId must be a non-empty string.')
  return { ok: true, value: { ...parsed.value, briefId } }
}

export function parseUpdateRavelBriefAssignment(
  id: unknown,
  planRevision: unknown,
  briefId: unknown,
  assignment: unknown
): IpcValidation<{ id: string; planRevision: number; briefId: string; assignment: UpdateRavelBriefAssignmentRequest }> {
  const parsed = parseRavelBriefMutation(id, planRevision, briefId)
  if (!parsed.ok) return parsed
  if (!isIpcObject(assignment)) return invalid('assignment must be an object.')

  const keys = Object.keys(assignment)
  if (keys.length === 0) return invalid('assignment must set role, harness, or model.')
  if (keys.some((key) => key !== 'role' && key !== 'harness' && key !== 'model')) {
    return invalid('assignment may only include role, harness, and model.')
  }

  const patch: UpdateRavelBriefAssignmentRequest = {}
  if (own(assignment, 'role')) {
    const parsedRole = childRole(assignment.role)
    if (!parsedRole.ok) return parsedRole
    patch.role = parsedRole.value
  }
  if (own(assignment, 'harness')) {
    const parsedHarness = harness(assignment.harness)
    if (!parsedHarness.ok) return parsedHarness
    patch.harness = parsedHarness.value
  }
  if (own(assignment, 'model')) {
    const value = assignment.model
    if (value === null) {
      patch.model = null
    } else {
      if (typeof value !== 'string' || value.trim().length === 0) {
        return invalid('assignment model must be a non-empty string or null.')
      }
      patch.model = value.trim()
    }
  }
  return { ok: true, value: { ...parsed.value, assignment: patch } }
}
