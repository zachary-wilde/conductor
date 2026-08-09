import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import type { PublicRavelConfig, RavelBrief, RavelDispatchRecord } from '@shared/types'
import { collectDispatches } from './collect-dispatches'

// Real git against real worktrees: the point of this module is that its numbers
// describe what a child actually did, which a mocked git cannot prove.
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

function newRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conductor-insight-'))
  tempDirs.push(dir)
  run(dir, 'init', '--initial-branch=main')
  run(dir, 'config', 'user.email', 'test@conductor.local')
  run(dir, 'config', 'user.name', 'Conductor Test')
  run(dir, 'config', 'commit.gpgsign', 'false')
  run(dir, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(dir, 'base.txt'), 'one\ntwo\nthree\n')
  run(dir, 'add', '-A')
  run(dir, 'commit', '-m', 'init')
  return dir
}

/** A worktree branched from HEAD, exactly as toolSpawnChild creates one. */
function worktreeFrom(repo: string, branch: string): { path: string; baseCommit: string } {
  const baseCommit = run(repo, 'rev-parse', 'HEAD').trim()
  const path = join(repo, '..', `${branch}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  tempDirs.push(path)
  run(repo, 'worktree', 'add', '-b', branch, path, baseCommit)
  return { path, baseCommit }
}

function brief(overrides: Partial<RavelBrief> = {}): RavelBrief {
  return {
    id: 'brief-1',
    title: 'Repair the refresh path',
    role: 'lead-engineer',
    harness: 'claude',
    model: null,
    phase: 'implementation',
    goal: 'Fix it',
    relevantContext: [],
    constraints: [],
    acceptanceCriteria: [],
    doNotTouch: [],
    expectedOutput: 'a fix',
    escalationConditions: [],
    dependsOn: [],
    contextExceptionReason: null,
    ...overrides
  }
}

function dispatch(overrides: Partial<RavelDispatchRecord> = {}): RavelDispatchRecord {
  return {
    briefId: 'brief-1',
    planRevision: 1,
    sessionId: 'session-1',
    branch: 'ravel/brief-1',
    worktreePath: 'D:/nowhere',
    status: 'active',
    startedAt: 1_720_000_000_000,
    endedAt: null,
    baseCommit: null,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: null },
    report: null,
    contextRequests: 0,
    verification: null,
    ...overrides
  }
}

function ravel(dispatches: RavelDispatchRecord[], briefs: RavelBrief[]): PublicRavelConfig {
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
    messages: [],
    plan: {
      revision: 1,
      createdAt: 0,
      sourceMessageIds: [],
      mission: { goal: 'g', context: [], constraints: [], acceptanceCriteria: [], assumptions: [] },
      orientation: '',
      briefs,
      approvedAt: 0,
      approvedRevision: 1
    },
    dispatches,
    createdAt: 0,
    error: null,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: null }
  }
}


describe('collectDispatches', () => {
  test('a ravel with no plan yields nothing rather than throwing', async () => {
    expect(await collectDispatches(null)).toEqual([])
  })

  test(
    'counts committed edits, and reports the paths the child touched',
    async () => {
      const repo = newRepo()
      const { path, baseCommit } = worktreeFrom(repo, 'ravel/brief-1')
      writeFileSync(join(path, 'base.txt'), 'one\ntwo\nthree\nfour\n')
      run(path, 'add', '-A')
      run(path, 'commit', '-m', 'child work')

      const [snapshot] = await collectDispatches(
        ravel([dispatch({ worktreePath: path, baseCommit })], [brief()])
      )

      expect(snapshot.changedPaths).toEqual(['base.txt'])
      expect(snapshot.additions).toBe(1)
      expect(snapshot.deletions).toBe(0)
      expect(snapshot.commits).toBe(1)
    },
    TIMEOUT
  )

  test(
    'counts uncommitted work: an agent that never commits still changed the tree',
    async () => {
      const repo = newRepo()
      const { path, baseCommit } = worktreeFrom(repo, 'ravel/brief-2')
      writeFileSync(join(path, 'base.txt'), 'one\n')

      const [snapshot] = await collectDispatches(
        ravel([dispatch({ worktreePath: path, baseCommit })], [brief()])
      )

      expect(snapshot.changedPaths).toEqual(['base.txt'])
      expect(snapshot.deletions).toBe(2)
      expect(snapshot.commits).toBe(0)
    },
    TIMEOUT
  )

  test(
    'untracked files count as changes, with their whole contents as additions',
    async () => {
      const repo = newRepo()
      const { path, baseCommit } = worktreeFrom(repo, 'ravel/brief-3')
      writeFileSync(join(path, 'brand-new.ts'), 'a\nb\nc\n')

      const [snapshot] = await collectDispatches(
        ravel([dispatch({ worktreePath: path, baseCommit })], [brief()])
      )

      expect(snapshot.changedPaths).toEqual(['brand-new.ts'])
      expect(snapshot.additions).toBe(3)
    },
    TIMEOUT
  )

  test(
    'a worktree that changed nothing reports zero, which is itself a finding',
    async () => {
      const repo = newRepo()
      const { path, baseCommit } = worktreeFrom(repo, 'ravel/brief-4')

      const [snapshot] = await collectDispatches(
        ravel([dispatch({ worktreePath: path, baseCommit })], [brief()])
      )

      expect(snapshot.changedPaths).toEqual([])
      expect(snapshot.additions).toBe(0)
      expect(snapshot.commits).toBe(0)
    },
    TIMEOUT
  )

  /**
   * The distinction the whole module turns on: "we could not measure" must never
   * be reported as "the child changed nothing", because a rule fires on the latter.
   */
  test('a dispatch with no base commit is omitted, not reported as zero-change', async () => {
    const snapshots = await collectDispatches(
      ravel([dispatch({ baseCommit: null, worktreePath: 'D:/nowhere' })], [brief()])
    )
    expect(snapshots).toEqual([])
  })

  test('a worktree git cannot read is omitted too', async () => {
    const snapshots = await collectDispatches(
      ravel(
        [dispatch({ baseCommit: 'a'.repeat(40), worktreePath: join(tmpdir(), 'conductor-absent-worktree') })],
        [brief()]
      )
    )
    expect(snapshots).toEqual([])
  })

  test(
    'a dispatch whose brief was revised away is omitted rather than given a fake role',
    async () => {
      const repo = newRepo()
      const { path, baseCommit } = worktreeFrom(repo, 'ravel/brief-5')

      const snapshots = await collectDispatches(
        ravel([dispatch({ briefId: 'gone', worktreePath: path, baseCommit })], [brief()])
      )
      expect(snapshots).toEqual([])
    },
    TIMEOUT
  )

  test(
    'carries the brief guards and counts attempts per brief',
    async () => {
      const repo = newRepo()
      const first = worktreeFrom(repo, 'ravel/attempt-1')
      const second = worktreeFrom(repo, 'ravel/attempt-2')

      const snapshots = await collectDispatches(
        ravel(
          [
            dispatch({ branch: 'ravel/attempt-1', worktreePath: first.path, baseCommit: first.baseCommit, startedAt: 1 }),
            dispatch({ branch: 'ravel/attempt-2', worktreePath: second.path, baseCommit: second.baseCommit, startedAt: 2 })
          ],
          [brief({ doNotTouch: ['src/billing'] })]
        )
      )

      expect(snapshots.map((s) => s.attempt)).toEqual([1, 2])
      expect(snapshots[0].protectedPaths).toEqual(['src/billing'])
      expect(snapshots[0].role).toBe('lead-engineer')
      expect(new Set(snapshots.map((s) => s.key)).size).toBe(2)
    },
    TIMEOUT
  )
})
