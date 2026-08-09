// Pure view-model: builds the `ClientCommand` payloads the web UI issues.
//
// Every mutating command carries a client-generated `operationId` so the core
// deduplicates a reconnect retry. Each builder mints a fresh uuid by default
// (via `crypto.randomUUID`, available in every browser and Node ≥ 19) and
// ACCEPTS an explicit `operationId` so the exact wire payload is unit-testable.
//
// The optional payload fields (`message`, `confirmed`, `note`) are included ONLY
// when supplied, so a command never carries a stray `undefined` that a strict
// server would have to ignore.

import type {
  AutomationApproveCommand,
  AutomationSetEnabledCommand,
  AutomationUpsertCommand,
  ClientCommand,
  ReviewDecisionCommand,
  WorkerControlCommand
} from '@ops/api-contract'
import type { WorkerControlAction } from '@ops/worker-controls'
import type { AutomationDefinition } from '@ops/types'

/** A fresh operation id for command idempotency. Exposed for tests/mocks. */
export function newOperationId(): string {
  const c = globalThis.crypto as Crypto | undefined
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  // Fallback (non-crypto hosts); sufficient only as a last resort.
  return `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export interface WorkerControlOptions {
  /** Follow-up text for `message`. */
  message?: string
  /** Operator confirmation for stop/detach/archive. */
  confirmed?: boolean
  /** Override the minted operation id (tests). */
  operationId?: string
}

/** Build a `worker.control` command, including optional fields only when set. */
export function workerControl(
  workerId: string,
  action: WorkerControlAction,
  opts: WorkerControlOptions = {}
): WorkerControlCommand {
  const payload: {
    workerId: string
    action: WorkerControlAction
    message?: string
    confirmed?: boolean
  } = { workerId, action }
  if (opts.message !== undefined) payload.message = opts.message
  if (opts.confirmed !== undefined) payload.confirmed = opts.confirmed
  return {
    operationId: opts.operationId ?? newOperationId(),
    name: 'worker.control',
    payload
  }
}

export interface ReviewDecisionInput {
  repoId: string
  branch: string
  baseCommit: string
  headCommit: string
  diffDigest: string
  decision: 'request-changes' | 'reject' | 'land'
  note?: string
  confirmed?: boolean
  operationId?: string
}

/** Build a `review.decide` command. `confirmed` is required for `land`. */
export function reviewDecide(input: ReviewDecisionInput): ReviewDecisionCommand {
  const payload: {
    repoId: string
    branch: string
    baseCommit: string
    headCommit: string
    diffDigest: string
    decision: 'request-changes' | 'reject' | 'land'
    note?: string
    confirmed?: boolean
  } = {
    repoId: input.repoId,
    branch: input.branch,
    baseCommit: input.baseCommit,
    headCommit: input.headCommit,
    diffDigest: input.diffDigest,
    decision: input.decision
  }
  if (input.note !== undefined && input.note.trim().length > 0) payload.note = input.note
  if (input.confirmed !== undefined) payload.confirmed = input.confirmed
  return {
    operationId: input.operationId ?? newOperationId(),
    name: 'review.decide',
    payload
  }
}

/** Build an `automation.setEnabled` command. */
export function automationSetEnabled(
  automationId: string,
  enabled: boolean,
  operationId?: string
): AutomationSetEnabledCommand {
  return {
    operationId: operationId ?? newOperationId(),
    name: 'automation.setEnabled',
    payload: { automationId, enabled }
  }
}

/** Build an `automation.approve` command for an exact revision. */
export function automationApprove(
  automationId: string,
  revisionId: string,
  operationId?: string
): AutomationApproveCommand {
  return {
    operationId: operationId ?? newOperationId(),
    name: 'automation.approve',
    payload: { automationId, revisionId }
  }
}

/** Build an `automation.upsert` command (create or replace a definition). */
export function automationUpsert(
  definition: AutomationDefinition,
  operationId?: string
): AutomationUpsertCommand {
  return {
    operationId: operationId ?? newOperationId(),
    name: 'automation.upsert',
    payload: { definition }
  }
}

/** Discriminated-narrow helper: is this command a worker control? */
export function isWorkerControl(cmd: ClientCommand): cmd is WorkerControlCommand {
  return cmd.name === 'worker.control'
}
