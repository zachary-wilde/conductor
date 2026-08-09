// EVENT-NORMALIZER slice of the Operations Core: PURE projectors that map the
// app's existing activity records — a Ravel operator-log line, an ordinary
// session status transition, a session exit, a Roundtable turn — into the
// unified {@link UnsequencedEvent} shape the timeline consumes.
//
// Each projector is a total, side-effect-free function of its inputs: it reads
// no clock, performs no I/O, and invents nothing. The journal — not this module
// — assigns the monotonic `cursor`, so every projector returns an event WITHOUT
// a cursor. Event ids are derived deterministically from the source record
// (entry.id, turn.id, `${sessionId}:${status}`); where a truly unique id would
// require a clock we choose determinism over uniqueness, because the journal's
// cursor, never the event id, is the ordering and de-dup authority.
//
// The role / harness / model / attempt context a child event carries is
// RESOLVED HERE from the ravel config: a log line only knows its
// childSessionId, so the projector walks cfg.dispatches (to the brief) and
// cfg.plan.briefs (to the role / harness / model) to enrich it. When the config
// is unavailable or the dispatch is unknown, the unresolved fields are null
// rather than guessed — the contract is "project what is actually known".

import type {
  HarnessId,
  PublicRavelConfig,
  RavelLogEntry,
  RavelLogLevel,
  RavelRole,
  RoundtableConfig,
  RoundtableTurn,
  Session,
  SessionActivityEntry,
  SessionStatus
} from '@shared/types'
import type {
  EventKind,
  EventSourceIds,
  UnsequencedEvent,
  WorkflowKind,
  WorkerKind
} from './events'

/** The per-event context a ravel log line cannot carry itself. */
interface RavelLogContext {
  role: RavelRole | null
  harness: HarnessId | null
  model: string | null
  attempt: number
  source: EventSourceIds
}

/**
 * Project one ravel operator-log entry into a normalized timeline event.
 *
 * `cfg` supplies the repo / role / harness / model / brief context the log line
 * itself does not carry; pass null when the ravel config is unavailable, in
 * which case those context fields are null. A child line (`childSessionId` set)
 * is resolved to its brief's role / harness / model and a 1-based attempt number
 * counted across same-brief dispatches; a manager line (no `childSessionId`) is
 * tagged as the orchestrator and inherits the config's harness / model.
 */
export function normalizeRavelLog(
  entry: RavelLogEntry,
  cfg: PublicRavelConfig | null
): UnsequencedEvent {
  const childSessionId = entry.childSessionId ?? null

  return {
    id: entry.id,
    timestamp: entry.ts,
    repoId: cfg?.repoId ?? null,
    rootWorkflowId: entry.ravelId,
    rootWorkflowKind: 'ravel',
    parentWorkerId: null,
    workerId: childSessionId,
    workerKind: childSessionId === null ? 'ravel-manager' : 'ravel-child',
    ...ravelLogContext(entry.ravelId, childSessionId, cfg),
    kind: ravelLogKind(entry.event, entry.level),
    summary: entry.text,
    evidenceRefs: []
  }
}

/**
 * Resolve the role / harness / model / attempt / source for a ravel log line.
 *
 * Manager lines (no child session) are the orchestrator. Child lines resolve
 * their brief through `cfg.dispatches` (sessionId -> briefId) then
 * `cfg.plan.briefs` (briefId -> role / harness / model); the attempt is the
 * 1-based position of this dispatch among same-brief dispatches ordered by
 * `startedAt`, falling back to 1 when neither the dispatch nor its rank can be
 * established.
 */
function ravelLogContext(
  ravelId: string,
  childSessionId: string | null,
  cfg: PublicRavelConfig | null
): RavelLogContext {
  if (childSessionId === null) {
    return {
      role: 'orchestrator',
      harness: cfg?.harness ?? null,
      model: cfg?.model ?? null,
      attempt: 1,
      source: { ravelId }
    }
  }

  const dispatch =
    cfg?.dispatches.find((d) => d.sessionId === childSessionId) ?? null
  const brief =
    dispatch && cfg?.plan
      ? (cfg.plan.briefs.find((b) => b.id === dispatch.briefId) ?? null)
      : null

  let attempt = 1
  if (dispatch && cfg) {
    const ordered = cfg.dispatches
      .filter((d) => d.briefId === dispatch.briefId)
      .sort((a, b) => a.startedAt - b.startedAt)
    const rank = ordered.indexOf(dispatch)
    if (rank >= 0) attempt = rank + 1
  }

  return {
    role: brief?.role ?? null,
    harness: brief?.harness ?? null,
    model: brief?.model ?? null,
    attempt,
    source: {
      ravelId,
      briefId: dispatch?.briefId,
      sessionId: childSessionId
    }
  }
}

/**
 * Map a ravel operator-log `event` (+ severity `level`) onto a timeline
 * {@link EventKind}. The mapping is a fixed projection of the log vocabulary;
 * only the execution-shaped events (`spawn`, `child-exit`, `turn`) are promoted
 * to `failure` at error level — control / approval / verification categories
 * keep their meaning regardless of severity, since an errored "verify" is still
 * a verification result, not a generic failure.
 */
function ravelLogKind(event: string, level: RavelLogLevel): EventKind {
  const error = level === 'error'
  switch (event) {
    case 'spawn':
      return error ? 'failure' : 'lifecycle'
    case 'child-exit':
      return error ? 'failure' : 'lifecycle'
    case 'resume-brief':
      return 'lifecycle'
    case 'complete':
      return 'lifecycle'
    case 'verify':
      return 'verification'
    case 'approve':
      return 'approval'
    case 'plan':
      return 'approval'
    case 'plan-changes':
      return 'rejection'
    case 'plan-invalid':
      return 'failure'
    case 'budget':
      return 'budget'
    case 'context-request':
      return 'control-request'
    case 'pause':
      return 'control-result'
    case 'resume':
      return 'control-result'
    case 'retry':
      return 'control-result'
    case 'assignment':
      return 'control-result'
    case 'turn':
      return error ? 'failure' : 'tool'
    case 'message':
      return 'tool'
    case 'action':
      return 'tool'
    case 'reply':
      return 'conversation'
    default:
      return error ? 'failure' : 'lifecycle'
  }
}

/**
 * Project a NORMAL (non-ravel) session status transition. The event id and
 * timestamp are derived from the session (`lastActivityAt`) so the projection
 * stays pure — the journal supplies ordering via its cursor, so a deterministic
 * id is preferred over a clock-derived "unique" one.
 */
export function normalizeSessionStatus(
  session: Session,
  status: SessionStatus
): UnsequencedEvent {
  return baseSessionEvent(
    session,
    `${session.id}:${status}`,
    status === 'error' ? 'failure' : 'lifecycle',
    `session ${status}`
  )
}

/**
 * Project a NORMAL session exit. A non-zero exit code is a `failure`; a clean
 * exit is ordinary `lifecycle`. Like the status projector this reads no clock:
 * the timestamp is the session's last activity.
 */
export function normalizeSessionExit(
  session: Session,
  exitCode: number
): UnsequencedEvent {
  return baseSessionEvent(
    session,
    `${session.id}:exit`,
    exitCode === 0 ? 'lifecycle' : 'failure',
    `session exited (code ${exitCode})`
  )
}

/**
 * The shared skeleton of a normal-session event: the session is its own root
 * workflow and its own worker, carries no ravel role, and points its source back
 * at the session id. Only the id / kind / summary vary between status and exit.
 */
function baseSessionEvent(
  session: Session,
  id: string,
  kind: EventKind,
  summary: string
): UnsequencedEvent {
  return {
    id,
    timestamp: session.lastActivityAt,
    repoId: session.repoId,
    rootWorkflowId: session.id,
    rootWorkflowKind: 'session',
    parentWorkerId: null,
    workerId: session.id,
    workerKind: 'session',
    role: null,
    harness: session.harness,
    model: null,
    attempt: 1,
    kind,
    summary,
    evidenceRefs: [],
    source: { sessionId: session.id }
  }
}

/**
 * Project one roundtable turn (typically the newest appended) into a normalized
 * event. A turn from a seat is attributed to that seat (workerKind
 * `roundtable-seat`, harness / model from the seat); a turn with no seat is an
 * operator note and leaves worker / harness / model null. Long bodies are
 * clipped to 199 characters plus an ellipsis so the timeline summary stays a
 * summary — the full argument lives in the roundtable, not the event.
 */
export function normalizeRoundtableTurn(
  cfg: RoundtableConfig,
  turn: RoundtableTurn
): UnsequencedEvent {
  const seat =
    turn.seatId === null
      ? null
      : (cfg.seats.find((s) => s.id === turn.seatId) ?? null)

  return {
    id: turn.id,
    timestamp: turn.createdAt,
    repoId: cfg.repoId,
    rootWorkflowId: cfg.id,
    rootWorkflowKind: 'roundtable',
    parentWorkerId: null,
    workerId: turn.seatId,
    workerKind: turn.seatId === null ? null : 'roundtable-seat',
    role: null,
    harness: seat?.harness ?? null,
    model: seat?.model ?? null,
    attempt: 1,
    kind: 'conversation',
    summary: turn.body.length > 200 ? turn.body.slice(0, 199) + '\u2026' : turn.body,
    evidenceRefs: [],
    source: { roundtableId: cfg.id }
  }
}


/** The root-workflow / worker / role / source context a file-activity entry derives from its owning session. */
interface FileActivityContext {
  rootWorkflowId: string
  rootWorkflowKind: WorkflowKind
  workerId: string
  workerKind: WorkerKind
  role: RavelRole | null
  harness: HarnessId | null
  source: EventSourceIds
}

/**
 * Project one file-activity entry (a file added / edited / removed in a
 * session's worktree) into a normalized timeline event. The entry carries only
 * the path, its change kind, and a timestamp; the workflow / worker / role /
 * harness / source context is resolved entirely from the owning SESSION (not a
 * ravel config — the session already carries it). A `ravel-child` session roots
 * the event in its ravel and inherits its brief role; a `normal` session roots
 * the event in itself with no role. Like every projector here this reads no
 * clock: the timestamp is the entry's own `ts`, and the deterministic id
 * `file:<entry.id>` leans on the journal's cursor — never the id — for ordering.
 */
export function normalizeFileActivity(
  entry: SessionActivityEntry,
  session: Session
): UnsequencedEvent {
  const ctx = fileActivityContext(session)
  return {
    id: `file:${entry.id}`,
    timestamp: entry.ts,
    repoId: session.repoId,
    rootWorkflowId: ctx.rootWorkflowId,
    rootWorkflowKind: ctx.rootWorkflowKind,
    parentWorkerId: null,
    workerId: ctx.workerId,
    workerKind: ctx.workerKind,
    role: ctx.role,
    harness: ctx.harness,
    model: null,
    attempt: 1,
    kind: 'file',
    summary: `${entry.kind} ${entry.path}`,
    evidenceRefs: [entry.path],
    source: ctx.source
  }
}

/**
 * Resolve the root-workflow / worker / role / harness / source context for a
 * file-activity event from the owning session. Mirrors {@link ravelLogContext}:
 * a `ravel-child` session roots the event in its ravel and carries its brief
 * role; a `normal` session roots the event in itself with no role.
 */
function fileActivityContext(session: Session): FileActivityContext {
  if (session.kind === 'ravel-child') {
    return {
      rootWorkflowId: session.ravelId,
      rootWorkflowKind: 'ravel',
      workerId: session.id,
      workerKind: 'ravel-child',
      role: session.ravelRole,
      harness: session.harness,
      source: {
        ravelId: session.ravelId,
        briefId: session.briefId,
        sessionId: session.id
      }
    }
  }
  return {
    rootWorkflowId: session.id,
    rootWorkflowKind: 'session',
    workerId: session.id,
    workerKind: 'session',
    role: null,
    harness: session.harness,
    source: { sessionId: session.id }
  }
}