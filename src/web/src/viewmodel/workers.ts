// Pure view-model: derives the operator-visible WORKER list from the normalized
// timeline events.
//
// The timeline is the single source of truth — there is no separate worker
// registry the web client can read — so the worker list is a PURE projection of
// the events the client has already folded. Every event carries the worker
// identity that genuinely applies; an event with neither `workerId` nor a
// `source.sessionId` is not a controllable worker and is skipped.
//
// No I/O, no React, no clock. Deterministic and unit-testable.

import type { WorkerKind } from '@ops/events'
import type { NormalizedEvent } from '@ops/events'
import type { HarnessId, RavelRole } from '@shared/types'

/**
 * One row in the worker list. `key` is the stable identity used to open the
 * detail pane and to dedupe; `workerId` is the canonical id sent to
 * `worker.detail` / `worker.control` (it may equal the session id when an event
 * carried no explicit worker id).
 */
export interface WorkerSummary {
  key: string
  workerId: string
  sessionId: string | null
  workerKind: WorkerKind | null
  role: RavelRole | null
  harness: HarnessId | null
  model: string | null
  repoId: string | null
  rootWorkflowId: string
  rootWorkflowKind: NormalizedEvent['rootWorkflowKind']
  parentWorkerId: string | null
  lastSeen: number
  latestSummary: string
  latestKind: NormalizedEvent['kind']
  eventCount: number
}

/**
 * The stable identity of the worker an event belongs to. Prefers the explicit
 * `workerId`, falls back to the session id, and never invents one: an event
 * with neither is not attributable to a controllable worker.
 */
export function workerKey(ev: NormalizedEvent): string {
  return ev.workerId ?? ev.source.sessionId ?? ''
}

/**
 * Fold a cursor-ordered event list into the distinct workers it mentions,
 * newest-first. A worker's displayed role/harness/model/summary come from its
 * most-recent event; `eventCount` is the total events attributed to it. Events
 * without a worker id AND without a session id are dropped.
 */
export function deriveWorkers(events: readonly NormalizedEvent[]): WorkerSummary[] {
  const byKey = new Map<string, WorkerSummary>()

  for (const ev of events) {
    const key = workerKey(ev)
    if (!key) continue
    const prev = byKey.get(key)
    // The events arrive cursor-ascending, so a later timestamp is the newer
    // projection. Ties (same timestamp) still advance the summary so the row
    // reflects the latest fold.
    const isLatest = !prev || ev.timestamp >= prev.lastSeen
    byKey.set(key, {
      key,
      workerId: ev.workerId ?? key,
      sessionId: ev.source.sessionId ?? null,
      workerKind: ev.workerKind,
      role: ev.role,
      harness: ev.harness,
      model: ev.model,
      repoId: ev.repoId,
      rootWorkflowId: ev.rootWorkflowId,
      rootWorkflowKind: ev.rootWorkflowKind,
      parentWorkerId: ev.parentWorkerId,
      lastSeen: isLatest ? ev.timestamp : prev!.lastSeen,
      latestSummary: isLatest ? ev.summary : prev!.latestSummary,
      latestKind: isLatest ? ev.kind : prev!.latestKind,
      eventCount: (prev?.eventCount ?? 0) + 1
    })
  }

  return [...byKey.values()].sort((a, b) => b.lastSeen - a.lastSeen)
}

