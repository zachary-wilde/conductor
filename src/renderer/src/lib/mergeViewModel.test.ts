import { describe, expect, test } from 'vitest'
import type {
  MergeFailure,
  MergeLanded,
  MergePreviewEntry,
  RavelBrief,
  RavelDispatchRecord,
  RavelPlan
} from '@shared/types'
import {
  clipPaths,
  landedSummary,
  mergeFailureSummary,
  mergeReviewRows,
  overlapSummary,
  reviewRowState,
  type LandedRecord
} from './mergeViewModel'
import { ravelFixture } from './testStubs'

const STARTED_AT = 1_720_000_000_000

function dispatch(overrides: Partial<RavelDispatchRecord> = {}): RavelDispatchRecord {
  return {
    briefId: 'brief-1',
    planRevision: 3,
    sessionId: 'session-1',
    branch: 'ravel/brief-1',
    worktreePath: 'D:/repo/.worktrees/brief-1',
    status: 'completed',
    startedAt: STARTED_AT,
    endedAt: null,
    baseCommit: 'c'.repeat(40),
    usage: { inputTokens: 0, outputTokens: 0, costUsd: null },
    report: null,
    contextRequests: 0,
    verification: null,
    ...overrides
  }
}

function brief(id: string, title: string): RavelBrief {
  return {
    id,
    title,
    role: 'minor-task',
    harness: 'claude',
    model: null,
    phase: 'implementation',
    goal: title,
    relevantContext: [],
    constraints: [],
    acceptanceCriteria: [],
    doNotTouch: [],
    expectedOutput: 'Completed work',
    escalationConditions: [],
    dependsOn: [],
    contextExceptionReason: null
  }
}

function plan(briefs: RavelBrief[], revision = 3): RavelPlan {
  return {
    revision,
    createdAt: STARTED_AT,
    sourceMessageIds: [],
    orientation: 'Complete the planned work.',
    mission: {
      goal: 'Ship the plan',
      context: [],
      constraints: [],
      acceptanceCriteria: [],
      assumptions: []
    },
    briefs,
    approvedAt: STARTED_AT,
    approvedRevision: revision
  }
}

function preview(overrides: Partial<MergePreviewEntry> = {}): MergePreviewEntry {
  return {
    branch: 'ravel/brief-1',
    files: ['src/feature.ts'],
    conflictsWithBase: false,
    conflictPaths: [],
    overlaps: [],
    error: null,
    ...overrides
  }
}

function mergeResult(overrides: Partial<MergeLanded> = {}): MergeLanded {
  return {
    ok: true,
    branch: 'ravel/brief-1',
    commit: 'abcdef1234567890',
    alreadyMerged: false,
    files: ['src/feature.ts'],
    warning: null,
    ...overrides
  }
}

function landedRecord(squashed = false, overrides: Partial<MergeLanded> = {}): LandedRecord {
  return { result: mergeResult(overrides), squashed }
}

describe('mergeReviewRows', () => {
  test('returns one row per completed branch in newest-dispatch order because unfinished outcomes are not reviewable', () => {
    const cfg = ravelFixture({
      plan: plan([
        brief('brief-oldest', 'Oldest work'),
        brief('brief-middle', 'Middle work'),
        brief('brief-newest', 'Newest work')
      ]),
      dispatches: [
        dispatch({ briefId: 'brief-oldest', branch: 'ravel/oldest', startedAt: 100 }),
        dispatch({ briefId: 'active', branch: 'ravel/active', status: 'active', startedAt: 700 }),
        dispatch({ briefId: 'brief-newest', branch: 'ravel/newest', startedAt: 300 }),
        dispatch({ briefId: 'failed', branch: 'ravel/failed', status: 'failed', startedAt: 600 }),
        dispatch({ briefId: 'brief-middle', branch: 'ravel/middle', startedAt: 200 }),
        dispatch({ briefId: 'interrupted', branch: 'ravel/interrupted', status: 'interrupted', startedAt: 500 }),
        dispatch({ briefId: 'starting', branch: 'ravel/starting', status: 'starting', startedAt: 400 })
      ]
    })

    const rows = mergeReviewRows(cfg)

    expect(rows).toHaveLength(3)
    expect(rows.map((row) => row.branch)).toEqual(['ravel/newest', 'ravel/middle', 'ravel/oldest'])
    expect(rows.map((row) => row.title)).toEqual(['Newest work', 'Middle work', 'Oldest work'])
  })

  test('keeps the newest dispatch for a repeated branch while retaining older-plan work on a different branch', () => {
    const cfg = ravelFixture({
      plan: plan([brief('brief-current', 'Current brief')]),
      dispatches: [
        dispatch({
          briefId: 'brief-current',
          branch: 'ravel/reused',
          planRevision: 1,
          worktreePath: 'D:/repo/.worktrees/reused-old',
          startedAt: 100
        }),
        dispatch({
          briefId: 'brief-legacy',
          branch: 'ravel/legacy',
          planRevision: 1,
          worktreePath: 'D:/repo/.worktrees/legacy',
          startedAt: 200
        }),
        dispatch({
          briefId: 'brief-current',
          branch: 'ravel/reused',
          planRevision: 3,
          worktreePath: 'D:/repo/.worktrees/reused-new',
          startedAt: 300
        })
      ]
    })

    expect(mergeReviewRows(cfg)).toEqual([
      {
        briefId: 'brief-current',
        branch: 'ravel/reused',
        title: 'Current brief',
        planRevision: 3,
        startedAt: 300
      },
      {
        briefId: 'brief-legacy',
        branch: 'ravel/legacy',
        title: 'brief-legacy',
        planRevision: 1,
        startedAt: 200
      }
    ])
  })

  test('uses the brief id as the title when the current plan no longer names a completed dispatch', () => {
    const cfg = ravelFixture({
      plan: plan([brief('brief-current', 'Current brief')]),
      dispatches: [dispatch({ briefId: 'brief-removed', branch: 'ravel/removed' })]
    })

    expect(mergeReviewRows(cfg)[0].title).toBe('brief-removed')
  })
})

describe('reviewRowState', () => {
  test('gives deletion precedence over landing and landing precedence over every preview result', () => {
    const conflicting = preview({ conflictsWithBase: true })
    const landed = landedRecord()

    expect(reviewRowState(conflicting, landed, true).severity).toBe('deleted')
    expect(reviewRowState(conflicting, landed, false).severity).toBe('landed')
  })

  test('reports preview errors and previews that never ran as unknown instead of claiming a clean merge', () => {
    expect(reviewRowState(preview({ error: 'git unavailable' }), undefined, false).severity).toBe('unknown')
    expect(reviewRowState(preview({ conflictsWithBase: null }), undefined, false).severity).toBe('unknown')
  })

  test('distinguishes base conflicts, sibling overlaps, clean previews, and missing previews by their evidence', () => {
    const overlappingBranch = { branch: 'ravel/sibling', files: ['src/shared.ts'] }

    expect(
      reviewRowState(preview({ conflictsWithBase: true, overlaps: [overlappingBranch] }), undefined, false).severity
    ).toBe('conflict')
    expect(reviewRowState(preview({ overlaps: [overlappingBranch] }), undefined, false).severity).toBe('overlap')
    expect(reviewRowState(preview(), undefined, false).severity).toBe('clean')
    expect(reviewRowState(undefined, undefined, false).severity).toBe('unchecked')
  })

  test('allows landing despite conflict or uncertainty but allows deletion only after a non-squash landing', () => {
    expect(reviewRowState(preview({ conflictsWithBase: true }), undefined, false).canLand).toBe(true)
    expect(reviewRowState(preview({ conflictsWithBase: null }), undefined, false).canLand).toBe(true)
    expect(reviewRowState(undefined, undefined, false).canLand).toBe(true)
    expect(reviewRowState(preview(), landedRecord(), false).canLand).toBe(false)
    expect(reviewRowState(preview(), undefined, true).canLand).toBe(false)

    expect(reviewRowState(preview(), landedRecord(false), false).canDelete).toBe(true)
    expect(reviewRowState(preview(), landedRecord(true), false).canDelete).toBe(false)
    expect(reviewRowState(preview(), landedRecord(false), true).canDelete).toBe(false)
    expect(reviewRowState(preview(), undefined, false).canDelete).toBe(false)
  })
})

describe('overlapSummary', () => {
  test('returns no summary when no sibling branch shares a changed path', () => {
    expect(overlapSummary(preview())).toBeNull()
  })

  test('names every overlapping sibling and pluralises each branch file count independently', () => {
    const entry = preview({
      overlaps: [
        { branch: 'ravel/one-file', files: ['src/one.ts'] },
        { branch: 'ravel/two-files', files: ['src/two.ts', 'src/three.ts'] }
      ]
    })

    expect(overlapSummary(entry)).toBe(
      'Shares changed files with ravel/one-file (1 file), ravel/two-files (2 files). Heuristic warning from overlapping paths, not a trial merge.'
    )
  })
})

describe('landedSummary', () => {
  test('explains that no new merge was needed when the base already contained the branch', () => {
    expect(landedSummary(landedRecord(false, { branch: 'ravel/already', commit: null, alreadyMerged: true }))).toBe(
      'ravel/already was already contained in the base branch.'
    )
  })

  test('summarises a regular merge with a singular file count and an eight-character commit id', () => {
    expect(landedSummary(landedRecord(false, { commit: '1234567890abcdef', files: ['src/one.ts'] }))).toBe(
      'Merged 1 file as 12345678.'
    )
  })

  test('identifies a squash while pluralising its changed-file count', () => {
    expect(
      landedSummary(
        landedRecord(true, { commit: 'fedcba0987654321', files: ['src/one.ts', 'src/two.ts'] })
      )
    ).toBe('Squashed 2 files as fedcba09.')
  })
})

describe('mergeFailureSummary', () => {
  test('says the repository is intact only when the merge primitive confirmed it, and keeps the reported paths', () => {
    const conflict: MergeFailure = {
      ok: false,
      error: 'Merge conflict',
      paths: ['src/conflicted.ts'],
      restored: true
    }

    expect(mergeFailureSummary(conflict)).toBe(
      'Merge conflict. The repository is back where it started. Git reported: src/conflicted.ts.'
    )
  })

  test('tells the operator to look when restoration could not be confirmed', () => {
    const stranded: MergeFailure = { ok: false, error: 'Squash commit failed', restored: false }

    const summary = mergeFailureSummary(stranded)
    expect(summary).toContain('could NOT be confirmed')
    expect(summary).not.toContain('back where it started.')
  })

  test('a refusal that never touched the repository still reports it as intact', () => {
    expect(mergeFailureSummary({ ok: false, error: 'Branch is missing', restored: true })).toBe(
      'Branch is missing. The repository is back where it started.'
    )
  })
})

describe('clipPaths', () => {
  test('preserves lists through the limit boundary and clips only excess paths with an honest remainder count', () => {
    const paths = ['one', 'two', 'three', 'four', 'five']

    expect(clipPaths(paths.slice(0, 2), 3)).toEqual(['one', 'two'])
    expect(clipPaths(paths.slice(0, 3), 3)).toEqual(['one', 'two', 'three'])
    expect(clipPaths(paths, 3)).toEqual(['one', 'two', 'three', '+2 more'])
  })
})
