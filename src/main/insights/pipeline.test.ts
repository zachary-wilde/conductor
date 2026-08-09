import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { EMPTY_INSIGHT_STATE, type Insight, type InsightState } from '@shared/insights'
import type { PublicRavelConfig, RavelBrief, RavelDispatchRecord, Session } from '@shared/types'
import { collectDispatches } from './collect-dispatches'
import { InsightCoordinator } from './coordinator'

/**
 * The whole pipeline, end to end, with nothing faked but the store and the clock:
 * a real git worktree, the real collector, the real rules, the real coordinator.
 *
 * For a full session the engine and its 22 rule tests passed while NOTHING called
 * them — no coordinator was constructed and no trigger was ever fired. Unit tests
 * on the rules cannot catch that; this can.
 */
const TIMEOUT = 30_000

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function run(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

function repoWithChildWorktree(): { worktreePath: string; baseCommit: string } {
  const repo = mkdtempSync(join(tmpdir(), 'conductor-pipeline-'))
  tempDirs.push(repo)
  run(repo, 'init', '--initial-branch=main')
  run(repo, 'config', 'user.email', 'test@conductor.local')
  run(repo, 'config', 'user.name', 'Conductor Test')
  run(repo, 'config', 'commit.gpgsign', 'false')
  run(repo, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(repo, 'auth.ts'), 'export const refresh = () => null\n')
  run(repo, 'add', '-A')
  run(repo, 'commit', '-m', 'init')

  const baseCommit = run(repo, 'rev-parse', 'HEAD').trim()
  const worktreePath = join(repo, '..', `child-${Date.now()}`)
  tempDirs.push(worktreePath)
  run(repo, 'worktree', 'add', '-b', 'ravel/brief-1', worktreePath, baseCommit)

  // What the child did: a real edit, uncommitted, exactly as an agent leaves it.
  writeFileSync(join(worktreePath, 'auth.ts'), 'export const refresh = () => token\n')
  return { worktreePath, baseCommit }
}

const brief: RavelBrief = {
  id: 'brief-1',
  title: 'Repair the refresh path',
  role: 'lead-engineer',
  harness: 'claude',
  model: null,
  phase: 'implementation',
  goal: 'Fix the refresh drop',
  relevantContext: [],
  constraints: [],
  acceptanceCriteria: [],
  doNotTouch: [],
  expectedOutput: 'a fix',
  escalationConditions: [],
  dependsOn: [],
  contextExceptionReason: null
}

function ravelWith(dispatch: RavelDispatchRecord): PublicRavelConfig {
  return {
    id: 'ravel-1',
    name: 'Ravel',
    repoId: 'repo-1',
    repoPath: 'D:/repo',
    harness: 'claude',
    model: null,
    maxChildren: 4,
    allowRisky: false,
    status: 'running',
    activity: 'idle',
    managerSessionId: null,
    messages: [{ id: 'm1', author: 'user', body: 'fix the refresh', createdAt: 0, delivery: 'delivered' }],
    plan: {
      revision: 1,
      createdAt: 0,
      sourceMessageIds: ['m1'],
      mission: { goal: 'g', context: [], constraints: [], acceptanceCriteria: [], assumptions: [] },
      orientation: '',
      briefs: [brief],
      approvedAt: 0,
      approvedRevision: 1
    },
    dispatches: [dispatch],
    createdAt: 0,
    error: null,
    usage: { inputTokens: 100, outputTokens: 900, costUsd: null }
  }
}

function completedDispatch(worktreePath: string, baseCommit: string): RavelDispatchRecord {
  return {
    briefId: 'brief-1',
    planRevision: 1,
    sessionId: 'session-1',
    branch: 'ravel/brief-1',
    worktreePath,
    status: 'completed',
    startedAt: 1_000,
    endedAt: 2_000,
    baseCommit,
    usage: { inputTokens: 100, outputTokens: 900, costUsd: null },
    report: 'done',
    contextRequests: 0,
    // The condition verification.none-configured exists to notice.
    verification: null
  }
}

interface Harness {
  coordinator: InsightCoordinator
  emitted: (Insight | null)[]
  state: () => InsightState
}

function coordinatorFor(ravel: PublicRavelConfig, sessions: Session[] = []): Harness {
  let state: InsightState = structuredClone(EMPTY_INSIGHT_STATE)
  const emitted: (Insight | null)[] = []
  const coordinator = new InsightCoordinator({
    loadState: () => state,
    saveState: (next) => {
      state = next
    },
    emit: (insight) => emitted.push(insight),
    listSessions: () => sessions,
    activeRavel: (id) => (id === ravel.id ? ravel : null),
    collectDispatches,
    now: () => 5_000
  })
  return { coordinator, emitted, state: () => state }
}

/** No sleeping: the coordinator exposes the drain its fire-and-forget note starts. */
async function settle(harness: Harness, ravelId: string): Promise<void> {
  await harness.coordinator.settled(ravelId)
}

describe('insight pipeline', () => {
  test(
    'a real unverified change reaches the mascot as a real message',
    async () => {
      const { worktreePath, baseCommit } = repoWithChildWorktree()
      const ravel = ravelWith(completedDispatch(worktreePath, baseCommit))
      const harness = coordinatorFor(ravel)

      harness.coordinator.note('child-exit', ravel.id)
      await settle(harness, ravel.id)

      const insight = harness.emitted[0]
      expect(insight).not.toBeNull()
      expect(insight?.ruleId).toBe('verification.none-configured')
      // Named the real brief and the real file count measured from git.
      expect(insight?.message).toContain('Repair the refresh path')
      expect(insight?.message).toContain('1 file')
      expect(harness.state().current).toEqual(insight)
      expect(harness.coordinator.current()).toEqual(insight)
    },
    TIMEOUT
  )

  test(
    'the same evidence is never surfaced twice',
    async () => {
      const { worktreePath, baseCommit } = repoWithChildWorktree()
      const ravel = ravelWith(completedDispatch(worktreePath, baseCommit))
      const harness = coordinatorFor(ravel)

      harness.coordinator.note('child-exit', ravel.id)
      await settle(harness, ravel.id)
      harness.coordinator.note('child-exit', ravel.id)
      await settle(harness, ravel.id)

      expect(harness.emitted).toHaveLength(1)
    },
    TIMEOUT
  )

  test(
    'dismissing clears the live insight and tells the renderer',
    async () => {
      const { worktreePath, baseCommit } = repoWithChildWorktree()
      const ravel = ravelWith(completedDispatch(worktreePath, baseCommit))
      const harness = coordinatorFor(ravel)

      harness.coordinator.note('child-exit', ravel.id)
      await settle(harness, ravel.id)
      harness.coordinator.dismiss()

      expect(harness.coordinator.current()).toBeNull()
      expect(harness.emitted[harness.emitted.length - 1]).toBeNull()
    },
    TIMEOUT
  )

  /**
   * A legacy dispatch has no base commit, so the collector cannot measure it. The
   * rule that would fire here keys on "changed files and nothing verified it" — an
   * unmeasurable dispatch must therefore stay silent rather than claim a finding.
   */
  test('an unmeasurable dispatch produces no insight at all', async () => {
    const ravel = ravelWith({
      ...completedDispatch('D:/nowhere', 'x'.repeat(40)),
      baseCommit: null
    })
    const harness = coordinatorFor(ravel)

    harness.coordinator.note('child-exit', ravel.id)
    await settle(harness, ravel.id)

    expect(harness.emitted).toEqual([])
    expect(harness.coordinator.current()).toBeNull()
  })

  test('a trigger for an unknown ravel is harmless', async () => {
    const ravel = ravelWith(completedDispatch('D:/nowhere', 'x'.repeat(40)))
    const harness = coordinatorFor(ravel)

    harness.coordinator.note('child-exit', 'no-such-ravel')
    await settle(harness, 'no-such-ravel')

    expect(harness.emitted).toEqual([])
  })
})
