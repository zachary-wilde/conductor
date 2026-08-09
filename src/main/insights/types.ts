import type {
  ChildRavelRole,
  HarnessId,
  PublicRavelConfig,
  RavelDispatchRecord,
  RavelUsage,
  Session,
  DispatchVerification
} from '@shared/types'
import type { InsightCategory, InsightSeverity } from '@shared/insights'

/**
 * What caused an evaluation pass. Rules never poll — every pass hangs off a real state
 * transition that already happened, so an idle app evaluates nothing.
 */
export type InsightTrigger =
  | 'session-status'
  | 'dispatch-created'
  | 'activity-changed'
  | 'child-exit'
  | 'verification-landed'
  | 'plan-approved'
  | 'context-request'
  | 'ravel-completed'

export interface InsightDispatchSnapshot {
  /** briefId:startedAt:branch — stable across a dispatch's life. */
  key: string
  briefId: string
  briefTitle: string
  role: ChildRavelRole
  harness: HarnessId
  model: string | null
  status: RavelDispatchRecord['status']
  startedAt: number
  endedAt: number | null
  /** Paths changed in this child's worktree, relative and forward-slashed. */
  changedPaths: string[]
  /** Conservatively parsed `doNotTouch` entries from the brief. */
  protectedPaths: string[]
  additions: number
  deletions: number
  commits: number
  contextRequests: number
  /** How many times this brief has been dispatched, including this one. */
  attempt: number
  usage: RavelUsage
  verification: DispatchVerification | null
}

/**
 * Everything a rule may look at. `now` is injected rather than read from the clock so
 * rules stay pure and testable.
 */
export interface InsightSnapshot {
  now: number
  trigger: InsightTrigger
  ravel: PublicRavelConfig | null
  sessions: readonly Session[]
  dispatches: readonly InsightDispatchSnapshot[]
  /** Median output tokens across recent dispatches of the same role, when known. */
  roleMedianOutputTokens: Partial<Record<ChildRavelRole, number>>
  /** Words in the prompt that opened this ravel, for "you asked for a button". */
  openingPromptWords: number
}

export interface InsightCandidate {
  ruleId: string
  category: InsightCategory
  severity: InsightSeverity
  message: string
  dedupeKey: string
}

export interface InsightRule {
  id: string
  category: InsightCategory
  severity: InsightSeverity
  cooldownMs: number
  /** Pure. Must not read the clock, the filesystem, or any module state. */
  predicate: (snapshot: InsightSnapshot) => boolean
  format: (snapshot: InsightSnapshot) => { message: string; dedupeKey: string }
}

export const MINUTE = 60_000
