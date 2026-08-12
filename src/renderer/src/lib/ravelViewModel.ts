import type { ChildRavelRole, PublicRavelConfig, RavelActivity, RavelLogEntry, RavelMessage, RavelPlan, RavelStatus, Session, SessionActivityEntry } from '@shared/types'

const MAX_VIEW_ENTRIES = 200

export function mergeRavelPlanByRevision(current: RavelPlan | null, incoming: RavelPlan | null): RavelPlan | null {
  if (current === null) return incoming
  if (incoming === null) return null
  return incoming.revision < current.revision ? current : incoming
}

export function mergeRavelMessages(
  current: RavelMessage[],
  incoming: RavelMessage[],
  retainedIds: readonly string[] = []
): RavelMessage[] {
  return mergeCappedById(current, incoming, (message) => message.id, compareMessages, retainedIds)
}

export function mergeRavelLogs(current: RavelLogEntry[], incoming: RavelLogEntry[]): RavelLogEntry[] {
  return mergeCappedById(current, incoming, (entry) => entry.id, compareLogs)
}

/**
 * Fold freshly-fetched sessions into the known list, preferring the incoming
 * copy for ids already present.
 *
 * Ravel children are hydrated separately from `listSessions`, so the two
 * sources overlap; replacing by id keeps the newer status without dropping
 * unrelated sessions or duplicating a child that both calls returned.
 */
export function mergeSessions(current: Session[], incoming: Session[]): Session[] {
  if (incoming.length === 0) return current
  const byId = new Map(current.map((session) => [session.id, session]))
  for (const session of incoming) byId.set(session.id, session)
  return [...byId.values()]
}

export function mergeRavelConfig(
  current: PublicRavelConfig | undefined,
  incoming: PublicRavelConfig
): PublicRavelConfig {
  if (current === undefined) {
    return {
      ...incoming,
      messages: mergeRavelMessages([], incoming.messages, incoming.plan?.sourceMessageIds ?? [])
    }
  }

  const plan = mergeRavelConfigPlan(current, incoming)
  const staleIncoming = current.plan !== null && incoming.plan !== current.plan && plan === current.plan
  const base = staleIncoming ? current : { ...current, ...incoming }
  return {
    ...base,
    messages: mergeRavelMessages(current.messages, incoming.messages, plan?.sourceMessageIds ?? []),
    plan
  }
}

export function mergeRavelList(list: PublicRavelConfig[], incoming: PublicRavelConfig): PublicRavelConfig[] {
  const index = list.findIndex((item) => item.id === incoming.id)
  if (index === -1) return [...list, mergeRavelConfig(undefined, incoming)]

  const next = list.slice()
  next[index] = mergeRavelConfig(list[index], incoming)
  return next
}

export function canApprovePlanInView(plan: RavelPlan | null, selectedRevision: number | null, busy: boolean): boolean {
  return plan !== null && selectedRevision === plan.revision && !busy && plan.approvedRevision !== plan.revision
}

export function ravelStatusLabel(status: RavelStatus): string {
  switch (status) {
    case 'idle':
      return 'Idle'
    case 'awaiting-approval':
      return 'Awaiting approval'
    case 'running':
      return 'Running'
    case 'paused':
      return 'Paused'
    case 'completed':
      return 'Completed'
    case 'error':
      return 'Error'
  }
}

export function ravelActivityLabel(activity: RavelActivity): string {
  switch (activity) {
    case 'idle':
      return 'Idle'
    case 'thinking':
      return 'Thinking'
    case 'needs-clarification':
      return 'Needs clarification'
  }
}

export function childRavelRoleLabel(role: ChildRavelRole): string {
  switch (role) {
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

function mergeCappedById<T>(
  current: T[],
  incoming: T[],
  idOf: (item: T) => string,
  compare: (a: T, b: T) => number,
  retainedIds: readonly string[] = []
): T[] {
  const byId = new Map<string, T>()
  for (const item of current) byId.set(idOf(item), item)
  for (const item of incoming) byId.set(idOf(item), item)
  const sorted = [...byId.values()].sort(compare)
  if (sorted.length <= MAX_VIEW_ENTRIES) return sorted

  const retained = new Set(retainedIds)
  const pinned: T[] = []
  const unpinned: T[] = []
  for (const item of sorted) {
    if (retained.has(idOf(item))) pinned.push(item)
    else unpinned.push(item)
  }

  const pinnedToKeep = pinned.slice(-MAX_VIEW_ENTRIES)
  const unpinnedSlots = MAX_VIEW_ENTRIES - pinnedToKeep.length
  const unpinnedToKeep = unpinnedSlots > 0 ? unpinned.slice(-unpinnedSlots) : []
  return [...pinnedToKeep, ...unpinnedToKeep].sort(compare)
}

function mergeRavelConfigPlan(current: PublicRavelConfig, incoming: PublicRavelConfig): RavelPlan | null {
  const currentPlan = current.plan
  const incomingPlan = incoming.plan
  if (currentPlan !== null && incomingPlan === null) return currentPlan
  if (incomingPlan === null) return null
  if (currentPlan === null || currentPlan.revision !== incomingPlan.revision) {
    return mergeRavelPlanByRevision(currentPlan, incomingPlan)
  }

  if (hasMessageAdvantage(current.messages, incoming.messages)) return currentPlan
  const incomingHasNewerMessages = hasMessageAdvantage(incoming.messages, current.messages)
  const currentApproved = currentPlan.approvedRevision === currentPlan.revision
  const incomingApproved = incomingPlan.approvedRevision === incomingPlan.revision
  if (currentApproved && !incomingApproved && !incomingHasNewerMessages) return currentPlan
  return incomingPlan
}

/** Rows the Activity tab shows, newest first. */
export interface FleetActivityEntry {
  entry: SessionActivityEntry
  session: Session
  /** True when this is the operator working by hand, not a dispatched agent. */
  manual: boolean
}

/** Newest this many entries. Older file churn is noise, not signal. */
const MAX_ACTIVITY_ROWS = 120

/**
 * File activity the fleet should be able to see: this ravel's children, plus any
 * TERMINAL session open on the same repository.
 *
 * The second half is the point. A terminal is the operator working by hand, and
 * an orchestrator blind to that will happily dispatch a child onto a file its
 * owner is editing in another window. The activity watcher already polls every
 * session with a worktree, so the data was always there — the Activity tab was
 * simply filtering it out.
 *
 * Harness sessions the operator started outside the ravel are NOT included: they
 * are another agent's work, not the operator's, and attributing them to a human
 * seat would be a lie the "manual" flag then paints on screen.
 */
export function fleetActivity(
  entries: readonly SessionActivityEntry[],
  sessions: readonly Session[],
  ravel: { id: string; repoId: string }
): FleetActivityEntry[] {
  const relevant = new Map<string, { session: Session; manual: boolean }>()
  for (const session of sessions) {
    if (session.kind === 'ravel-child' && session.ravelId === ravel.id) {
      relevant.set(session.id, { session, manual: false })
      continue
    }
    if (session.kind === 'normal' && session.harness === null && session.repoId === ravel.repoId) {
      relevant.set(session.id, { session, manual: true })
    }
  }

  const rows: FleetActivityEntry[] = []
  for (const entry of entries) {
    const match = relevant.get(entry.sessionId)
    // An entry whose session is gone cannot be attributed, so it is dropped
    // rather than rendered as an orphan with no author.
    if (match === undefined) continue
    rows.push({ entry, session: match.session, manual: match.manual })
  }
  return rows.slice(-MAX_ACTIVITY_ROWS).reverse()
}

function hasMessageAdvantage(left: RavelMessage[], right: RavelMessage[]): boolean {
  const rightById = new Map<string, RavelMessage>()
  for (const message of right) rightById.set(message.id, message)
  for (const message of left) {
    const other = rightById.get(message.id)
    if (other === undefined || message.createdAt > other.createdAt) return true
  }
  return false
}

function compareMessages(a: RavelMessage, b: RavelMessage): number {
  return a.createdAt - b.createdAt || a.id.localeCompare(b.id)
}

function compareLogs(a: RavelLogEntry, b: RavelLogEntry): number {
  return a.ts - b.ts || a.id.localeCompare(b.id)
}
