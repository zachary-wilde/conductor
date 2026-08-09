// CORE-SERVICES adapter for the Operations Core: the glue that implements the
// api-contract's command/query/event-subscribe surface over injected core
// dependencies, with operation-id idempotency.
//
// This is the SEAM the web-server (and, in-process, the Electron renderer)
// delegates every action to. It holds no state of its own: the automation
// store, event journal, worker supervisor, and the safe merge/review primitives
// are all injected through `CoreDeps`, so the adapter is pure logic over those
// deps and is unit-testable with fakes. The wiring step that supplies the real
// store, journal, ravel, and supervisor is separate and comes later.
//
// The single piece of mutable state the adapter touches is `deps.operations`,
// the idempotency registry shared across reconnects. Every command is wrapped
// in `registerOperation` against it, so a retried operationId returns the prior
// result and never re-runs the work — a reconnect cannot spawn twice, land a
// branch twice, or send two prompts.

import { API_VERSION } from './api-contract'
import type {
  AutomationListItem,
  ClientCommand,
  ClientQuery,
  CommandResult,
  CoreHandshake,
  EventStreamFrame,
  QueryResults,
  ReviewDiff,
  ReviewListItem,
  WorkerDetailView
} from './api-contract'
import { availableControls, requiresConfirmation } from './worker-controls'
import type { WorkerControlAction, WorkerControlState } from './worker-controls'
import { registerOperation } from './occurrence-ledger'
import type { AutomationStore } from './automation-store'
import type { EventCursor, JournalReadResult, NormalizedEvent } from './events'
import type { CoreServices } from './web-server'

/** Re-export the seam contract so wiring code imports it from one place. */
export type { CoreServices }

/**
 * Everything the adapter needs, injected. No field is a singleton the adapter
 * reaches for on its own — keeping the whole object injectable is what makes the
 * adapter unit-testable with fakes and lets the wiring step swap in the real
 * store, journal, supervisor, and merge primitive later.
 */
export interface CoreDeps {
  coreVersion: string
  storeSchemaVersion: number
  capabilities: string[]
  automations: AutomationStore
  journal: {
    latest(): EventCursor
    readAfter(after: EventCursor, limit?: number): JournalReadResult
  }
  liveEvents: {
    subscribe(onEvent: (event: NormalizedEvent) => void): () => void
  }
  workers: {
    detail(
      workerId: string
    ): {
      controlState: WorkerControlState
      latestEvents: NormalizedEvent[]
      dependentBriefs: string[]
    } | null
  }
  /** Execute a validated worker control; returns a safe value or throws. */
  applyWorkerControl(input: {
    workerId: string
    action: WorkerControlAction
    message?: string
  }): Promise<unknown>
  /** Execute a review decision against the safe merge primitive; throws on failure. */
  applyReviewDecision(
    cmd: Extract<ClientCommand, { name: 'review.decide' }>['payload']
  ): Promise<unknown>
  /** List branches that finished work and are candidates for review/land. */
  listReviews(): Promise<ReviewListItem[]>
  /** Bounded unified diff for one reviewable branch (files, patches, budget states). */
  diffReview(repoId: string, branch: string): Promise<ReviewDiff>
  /** Idempotency registry shared across reconnects: operationId -> prior result. */
  operations: Map<string, CommandResult>
}

/**
 * Build the {@link CoreServices} seam over injected `deps`. The returned object
 * is what the web-server consumes; it carries no mutable state of its own
 * beyond `deps.operations`.
 */
export function createCoreServices(deps: CoreDeps): CoreServices {
  return {
    handshake: () => handshake(deps),
    handleCommand: (cmd) => handleCommand(deps, cmd),
    handleQuery: <Q extends ClientQuery>(q: Q) => handleQuery(deps, q),
    subscribe: (afterCursor, onFrame) => subscribe(deps, afterCursor, onFrame)
  }
}

/** The core's opening handshake: versions, capabilities, and the newest cursor. */
function handshake(deps: CoreDeps): CoreHandshake {
  return {
    coreVersion: deps.coreVersion,
    apiVersion: API_VERSION,
    storeSchemaVersion: deps.storeSchemaVersion,
    capabilities: deps.capabilities,
    cursor: deps.journal.latest()
  }
}

/**
 * Dispatch a command under operation-id idempotency. The whole dispatch is
 * wrapped in `registerOperation`; because that helper is synchronous, we
 * memoize the in-flight dispatch Promise in the registry (its logical stored
 * value is the resolved CommandResult — the Promise is only its synchronous
 * stand-in until it settles). A retried operationId finds the stored entry,
 * skips the dispatch entirely, and gets the prior result back flagged
 * `deduplicated: true`.
 */
function handleCommand(deps: CoreDeps, cmd: ClientCommand): Promise<CommandResult> {
  const isRepeat = deps.operations.has(cmd.operationId)
  const pending = registerOperation(
    // registerOperation is sync; the in-flight Promise is the synchronous
    // stand-in for the not-yet-resolved CommandResult the registry logically
    // holds.
    deps.operations as unknown as Map<string, Promise<CommandResult>>,
    cmd.operationId,
    () => dispatch(deps, cmd)
  )
  return pending.then((result) =>
    isRepeat ? { ...result, deduplicated: true } : result
  )
}

/**
 * Execute one command by name. Validation failures return typed error results
 * directly; any thrown dep error is caught and surfaced as a safe
 * `command-failed` result with no stack leak.
 */
async function dispatch(deps: CoreDeps, cmd: ClientCommand): Promise<CommandResult> {
  try {
    switch (cmd.name) {
      case 'worker.control': {
        const { workerId, action, message, confirmed } = cmd.payload
        const detail = deps.workers.detail(workerId)
        if (!detail) {
          return err(cmd.operationId, 'unknown-worker', `No worker found for id "${workerId}"`)
        }
        if (!availableControls(detail.controlState).includes(action)) {
          return err(
            cmd.operationId,
            'invalid-control',
            `Action "${action}" is not available for worker "${workerId}"`
          )
        }
        if (requiresConfirmation(action, detail.controlState) && confirmed !== true) {
          return err(
            cmd.operationId,
            'confirmation-required',
            `Action "${action}" requires operator confirmation`
          )
        }
        await deps.applyWorkerControl({ workerId, action, message })
        return ok(cmd.operationId)
      }
      case 'automation.upsert': {
        deps.automations.putDefinition(cmd.payload.definition)
        return ok(cmd.operationId)
      }
      case 'automation.addRevision': {
        deps.automations.addRevision(cmd.payload.automationId, cmd.payload.revision)
        return ok(cmd.operationId)
      }
      case 'automation.approve': {
        // Approval binds to the exact revision id; the store throws if it is absent.
        deps.automations.setCurrentRevision(cmd.payload.automationId, cmd.payload.revisionId)
        return ok(cmd.operationId)
      }
      case 'automation.setEnabled': {
        const def = deps.automations.getDefinition(cmd.payload.automationId)
        if (!def) {
          return err(
            cmd.operationId,
            'unknown-automation',
            `No automation found for id "${cmd.payload.automationId}"`
          )
        }
        const current = def.revisions.find((r) => r.id === def.currentRevisionId)
        if (!current) {
          return err(
            cmd.operationId,
            'unknown-automation',
            `Automation "${cmd.payload.automationId}" has no current revision`
          )
        }
        // Flip the current revision's enabled flag; everything else is preserved.
        const nextRevision = { ...current, enabled: cmd.payload.enabled }
        deps.automations.putDefinition({
          ...def,
          revisions: def.revisions.map((r) => (r.id === current.id ? nextRevision : r))
        })
        return ok(cmd.operationId)
      }
      case 'review.decide': {
        await deps.applyReviewDecision(cmd.payload)
        return ok(cmd.operationId)
      }
      default: {
        // Exhaustiveness guard: adding a command without a case fails to compile.
        const _exhaustive: never = cmd
        return err((_exhaustive as ClientCommand).operationId, 'command-failed', 'Unhandled command')
      }
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    return err(cmd.operationId, 'command-failed', message)
  }
}

/** Resolve one query by name. Unknown projections throw so the server surfaces them. */
async function handleQuery<Q extends ClientQuery>(
  deps: CoreDeps,
  q: Q
): Promise<QueryResults[Q['name']]> {
  switch (q.name) {
    case 'timeline.read':
      return deps.journal.readAfter(q.afterCursor, q.limit) as QueryResults[Q['name']]
    case 'worker.detail': {
      const detail = deps.workers.detail(q.workerId)
      if (!detail) {
        throw new Error(`Unknown worker: "${q.workerId}"`)
      }
      const view: WorkerDetailView = {
        workerId: q.workerId,
        controlState: detail.controlState,
        availableControls: availableControls(detail.controlState),
        latestEvents: detail.latestEvents,
        dependentBriefs: detail.dependentBriefs
      }
      return view as QueryResults[Q['name']]
    }
    case 'automation.list': {
      const items: AutomationListItem[] = deps.automations.listDefinitions().map((def) => {
        const currentRevision = def.revisions.find((r) => r.id === def.currentRevisionId)
        if (!currentRevision) {
          throw new Error(`Automation "${def.id}" has no current revision`)
        }
        const recentOccurrences = deps.automations.listOccurrences(def.id)
        return { definition: def, currentRevision, recentOccurrences }
      })
      return items as QueryResults[Q['name']]
    }
    case 'review.list':
      return (await deps.listReviews()) as QueryResults[Q['name']]
    case 'review.diff':
      return (await deps.diffReview(q.repoId, q.branch)) as QueryResults[Q['name']]
    default: {
      // Exhaustiveness guard: adding a query without a case fails to compile.
      const _exhaustive: never = q
      throw new Error(`Unhandled query: "${(_exhaustive as ClientQuery).name}"`)
    }
  }
}

/**
 * Replay the journal from `afterCursor`, then forward live events. A gap (the
 * requested cursor has rotated out of the bounded journal) is reported as a
 * `gap` frame so the client resyncs; the retained events are still pushed, and
 * live forwarding continues. De-duplication against the client's existing tail
 * is the client's job. Returns an unsubscribe that detaches the live feed.
 */
function subscribe(
  deps: CoreDeps,
  afterCursor: EventCursor,
  onFrame: (frame: EventStreamFrame) => void
): () => void {
  const replay = deps.journal.readAfter(afterCursor)
  if (replay.gap) {
    onFrame({ type: 'gap', earliestAvailable: replay.gap.earliestAvailable })
  }
  for (const event of replay.events) {
    onFrame({ type: 'event', event })
  }
  // A guard so a frame emitted by the live feed just as the caller detaches is
  // dropped rather than delivered after the caller stopped listening.
  let detached = false
  const detachLive = deps.liveEvents.subscribe((event) => {
    if (detached) return
    onFrame({ type: 'event', event })
  })
  return () => {
    detached = true
    detachLive()
  }
}

/** A successful command result carrying no value. */
function ok(operationId: string): CommandResult {
  return { ok: true, operationId, deduplicated: false }
}

/** A typed, safe command error result (no stack, no internals). */
function err(operationId: string, code: string, message: string): CommandResult {
  return { ok: false, operationId, deduplicated: false, error: { code, message } }
}
