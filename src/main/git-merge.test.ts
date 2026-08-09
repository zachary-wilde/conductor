import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { changedFiles, deleteMergedBranch, mergeBranch, mergePreview } from './git'

// Every test drives a real repository through real git, so each one spawns
// dozens of processes and needs more than vitest's five-second default.
const TIMEOUT = 30_000

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function run(dir: string, ...args: string[]): string {
  // stderr is piped, not inherited: git narrates every checkout and that noise
  // would drown the suite's output.
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

function commit(dir: string, files: Record<string, string>, message: string): void {
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
  run(dir, 'add', '-A')
  run(dir, 'commit', '-m', message)
}

/** A real repo on `main` with one commit and a local identity to commit with. */
function newRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conductor-git-'))
  tempDirs.push(dir)
  run(dir, 'init', '--initial-branch=main')
  run(dir, 'config', 'user.email', 'test@conductor.local')
  run(dir, 'config', 'user.name', 'Conductor Test')
  run(dir, 'config', 'commit.gpgsign', 'false')
  // Without this the host's autocrlf rewrites line endings on checkout, so a
  // restored file would differ from the one the test wrote byte for byte.
  run(dir, 'config', 'core.autocrlf', 'false')
  commit(dir, { 'base.txt': 'base\n', 'shared.txt': 'one\ntwo\nthree\n' }, 'init')
  return dir
}

/** Commits `files` on a branch cut from `main`, then leaves the repo on `main`. */
function branchWith(dir: string, branch: string, files: Record<string, string>): void {
  run(dir, 'checkout', '-b', branch, 'main')
  commit(dir, files, `${branch} work`)
  run(dir, 'checkout', 'main')
}

interface RepoState {
  head: string
  branch: string
  status: string
  shared: string
}

function state(dir: string): RepoState {
  return {
    head: run(dir, 'rev-parse', 'HEAD').trim(),
    branch: run(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim(),
    status: run(dir, 'status', '--porcelain'),
    shared: readFileSync(join(dir, 'shared.txt'), 'utf8')
  }
}

function commitCount(dir: string, ref: string): number {
  return Number(run(dir, 'rev-list', '--count', ref).trim())
}

describe('changedFiles', () => {
  test(
    'reports only the branch own work, not commits the base gained afterwards',
    async () => {
      const dir = newRepo()
      branchWith(dir, 'ravel/feature-a1b2', { 'feature.txt': 'feature\n' })
      commit(dir, { 'base-moved.txt': 'later\n' }, 'base moves on')

      expect(await changedFiles(dir, 'ravel/feature-a1b2', 'main')).toEqual(['feature.txt'])
    },
    TIMEOUT
  )
})

describe('mergeBranch', () => {
  test(
    'lands a clean branch as a merge commit',
    async () => {
      const dir = newRepo()
      branchWith(dir, 'ravel/feature-a1b2', { 'feature.txt': 'feature\n' })
      const before = commitCount(dir, 'main')

      const result = await mergeBranch(dir, 'ravel/feature-a1b2', 'main')

      expect(result).toMatchObject({ ok: true, alreadyMerged: false, files: ['feature.txt'], warning: null })
      if (!result.ok) throw new Error('merge should have succeeded')
      expect(result.commit).toBe(run(dir, 'rev-parse', 'main').trim())
      expect(commitCount(dir, 'main')).toBe(before + 2)
      expect(existsSync(join(dir, 'feature.txt'))).toBe(true)
      expect(state(dir).status).toBe('')
    },
    TIMEOUT
  )

  test(
    'reports the conflicting paths and leaves the repo exactly as it was',
    async () => {
      const dir = newRepo()
      branchWith(dir, 'ravel/feature-a1b2', { 'shared.txt': 'one\nBRANCH\nthree\n', 'extra.txt': 'extra\n' })
      commit(dir, { 'shared.txt': 'one\nBASE\nthree\n' }, 'base edits the shared file')
      const before = state(dir)

      const result = await mergeBranch(dir, 'ravel/feature-a1b2', 'main')

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('merge should have conflicted')
      expect(result.paths).toEqual(['shared.txt'])
      expect(result.error).toContain('shared.txt')
      expect(state(dir)).toEqual(before)
      // The result must SAY what the repository state proves, because the UI
      // repeats that claim to the operator verbatim.
      expect(result.restored).toBe(true)
      expect(existsSync(join(dir, '.git', 'MERGE_HEAD'))).toBe(false)
      expect(existsSync(join(dir, 'extra.txt'))).toBe(false)
    },
    TIMEOUT
  )

  test(
    'a conflicted squash leaves no half-applied state behind',
    async () => {
      const dir = newRepo()
      branchWith(dir, 'ravel/feature-a1b2', { 'shared.txt': 'one\nBRANCH\nthree\n' })
      commit(dir, { 'shared.txt': 'one\nBASE\nthree\n' }, 'base edits the shared file')
      const before = state(dir)

      const result = await mergeBranch(dir, 'ravel/feature-a1b2', 'main', { squash: true })

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('squash should have conflicted')
      expect(result.paths).toEqual(['shared.txt'])
      expect(state(dir)).toEqual(before)
      expect(result.restored).toBe(true)
    },
    TIMEOUT
  )

  test(
    'squash lands several branch commits as one',
    async () => {
      const dir = newRepo()
      run(dir, 'checkout', '-b', 'ravel/feature-a1b2', 'main')
      commit(dir, { 'feature.txt': 'first\n' }, 'first')
      commit(dir, { 'feature.txt': 'first\nsecond\n' }, 'second')
      run(dir, 'checkout', 'main')
      const before = commitCount(dir, 'main')

      const result = await mergeBranch(dir, 'ravel/feature-a1b2', 'main', {
        squash: true,
        message: 'land feature'
      })

      expect(result).toMatchObject({ ok: true, alreadyMerged: false, files: ['feature.txt'] })
      expect(commitCount(dir, 'main')).toBe(before + 1)
      expect(run(dir, 'log', '-1', '--pretty=%s', 'main').trim()).toBe('land feature')
      expect(readFileSync(join(dir, 'feature.txt'), 'utf8')).toContain('second')
      expect(state(dir).status).toBe('')
    },
    TIMEOUT
  )

  test(
    'a second merge of the same branch reports it as already merged',
    async () => {
      const dir = newRepo()
      branchWith(dir, 'ravel/feature-a1b2', { 'feature.txt': 'feature\n' })
      await mergeBranch(dir, 'ravel/feature-a1b2', 'main')
      const head = run(dir, 'rev-parse', 'main').trim()

      const result = await mergeBranch(dir, 'ravel/feature-a1b2', 'main')

      expect(result).toMatchObject({ ok: true, alreadyMerged: true, commit: null, files: [] })
      expect(run(dir, 'rev-parse', 'main').trim()).toBe(head)
    },
    TIMEOUT
  )

  test(
    'returns to the branch the repo was on before the merge',
    async () => {
      const dir = newRepo()
      branchWith(dir, 'ravel/feature-a1b2', { 'feature.txt': 'feature\n' })
      run(dir, 'checkout', '-b', 'side', 'main')

      const result = await mergeBranch(dir, 'ravel/feature-a1b2', 'main')

      expect(result).toMatchObject({ ok: true, warning: null })
      expect(state(dir).branch).toBe('side')
      expect(run(dir, 'merge-base', '--is-ancestor', 'ravel/feature-a1b2', 'main')).toBe('')
    },
    TIMEOUT
  )

  test(
    'refuses to start against a dirty working tree',
    async () => {
      const dir = newRepo()
      branchWith(dir, 'ravel/feature-a1b2', { 'feature.txt': 'feature\n' })
      writeFileSync(join(dir, 'base.txt'), 'edited by the operator\n')
      const before = state(dir)

      const result = await mergeBranch(dir, 'ravel/feature-a1b2', 'main')

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('merge should have been refused')
      expect(result.paths).toEqual(['base.txt'])
      expect(state(dir)).toEqual(before)
      expect(readFileSync(join(dir, 'base.txt'), 'utf8')).toBe('edited by the operator\n')
    },
    TIMEOUT
  )

  test(
    'refuses a branch that does not exist without touching the repo',
    async () => {
      const dir = newRepo()
      const before = state(dir)

      expect(await mergeBranch(dir, 'ravel/missing-9999', 'main')).toEqual({
        ok: false,
        error: "branch 'ravel/missing-9999' does not exist",
        restored: true
      })
      expect(state(dir)).toEqual(before)
    },
    TIMEOUT
  )
})

describe('mergePreview', () => {
  test(
    'disjoint branches report no overlap and no conflict',
    async () => {
      const dir = newRepo()
      branchWith(dir, 'ravel/alpha-a1b2', { 'alpha.txt': 'alpha\n' })
      branchWith(dir, 'ravel/beta-c3d4', { 'beta.txt': 'beta\n' })
      const before = state(dir)

      const preview = await mergePreview(dir, ['ravel/alpha-a1b2', 'ravel/beta-c3d4'], 'main')

      expect(preview.ok).toBe(true)
      if (!preview.ok) throw new Error('preview should have succeeded')
      expect(preview.entries).toEqual([
        {
          branch: 'ravel/alpha-a1b2',
          files: ['alpha.txt'],
          conflictsWithBase: false,
          conflictPaths: [],
          overlaps: [],
          error: null
        },
        {
          branch: 'ravel/beta-c3d4',
          files: ['beta.txt'],
          conflictsWithBase: false,
          conflictPaths: [],
          overlaps: [],
          error: null
        }
      ])
      expect(state(dir)).toEqual(before)
    },
    TIMEOUT
  )

  test(
    'overlapping branches name the files they share',
    async () => {
      const dir = newRepo()
      branchWith(dir, 'ravel/alpha-a1b2', { 'shared.txt': 'ALPHA\ntwo\nthree\n', 'alpha.txt': 'alpha\n' })
      branchWith(dir, 'ravel/beta-c3d4', { 'shared.txt': 'one\ntwo\nBETA\n' })

      const preview = await mergePreview(dir, ['ravel/alpha-a1b2', 'ravel/beta-c3d4'], 'main')

      expect(preview.ok).toBe(true)
      if (!preview.ok) throw new Error('preview should have succeeded')
      const [alpha, beta] = preview.entries
      expect(alpha.overlaps).toEqual([{ branch: 'ravel/beta-c3d4', files: ['shared.txt'] }])
      expect(beta.overlaps).toEqual([{ branch: 'ravel/alpha-a1b2', files: ['shared.txt'] }])
      // Neither collides with the base: overlap is a warning about each other.
      expect(alpha.conflictsWithBase).toBe(false)
      expect(beta.conflictsWithBase).toBe(false)
    },
    TIMEOUT
  )

  test(
    'a branch that collides with the base reports the conflicting path',
    async () => {
      const dir = newRepo()
      branchWith(dir, 'ravel/alpha-a1b2', { 'shared.txt': 'one\nBRANCH\nthree\n' })
      commit(dir, { 'shared.txt': 'one\nBASE\nthree\n' }, 'base edits the shared file')
      const before = state(dir)

      const preview = await mergePreview(dir, ['ravel/alpha-a1b2'], 'main')

      expect(preview.ok).toBe(true)
      if (!preview.ok) throw new Error('preview should have succeeded')
      expect(preview.entries[0]).toMatchObject({
        conflictsWithBase: true,
        conflictPaths: ['shared.txt'],
        error: null
      })
      expect(state(dir)).toEqual(before)
    },
    TIMEOUT
  )

  test(
    'a missing branch is reported per entry, not as a failed preview',
    async () => {
      const dir = newRepo()
      branchWith(dir, 'ravel/alpha-a1b2', { 'alpha.txt': 'alpha\n' })

      const preview = await mergePreview(dir, ['ravel/alpha-a1b2', 'ravel/gone-0000'], 'main')

      expect(preview.ok).toBe(true)
      if (!preview.ok) throw new Error('preview should have succeeded')
      expect(preview.entries[1]).toMatchObject({
        files: [],
        conflictsWithBase: null,
        error: "branch 'ravel/gone-0000' does not exist"
      })
    },
    TIMEOUT
  )

  test(
    'a missing base branch fails the whole preview',
    async () => {
      const dir = newRepo()

      expect(await mergePreview(dir, [], 'nope')).toEqual({ ok: false, error: "base branch 'nope' does not exist" })
    },
    TIMEOUT
  )
})

describe('deleteMergedBranch', () => {
  test(
    'refuses an unmerged branch and keeps it',
    async () => {
      const dir = newRepo()
      branchWith(dir, 'ravel/feature-a1b2', { 'feature.txt': 'feature\n' })

      const result = await deleteMergedBranch(dir, 'ravel/feature-a1b2')

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('delete should have been refused')
      expect(result.error).toContain('not fully merged')
      expect(run(dir, 'rev-parse', '--verify', 'refs/heads/ravel/feature-a1b2').trim()).toHaveLength(40)
    },
    TIMEOUT
  )

  test(
    'deletes a branch that has landed on the checked-out base',
    async () => {
      const dir = newRepo()
      branchWith(dir, 'ravel/feature-a1b2', { 'feature.txt': 'feature\n' })
      await mergeBranch(dir, 'ravel/feature-a1b2', 'main')

      expect(await deleteMergedBranch(dir, 'ravel/feature-a1b2')).toEqual({
        ok: true,
        branch: 'ravel/feature-a1b2'
      })
      expect(run(dir, 'branch', '--list', '--format=%(refname:short)').trim()).toBe('main')
    },
    TIMEOUT
  )

  test(
    'refuses a branch that does not exist',
    async () => {
      const dir = newRepo()

      expect(await deleteMergedBranch(dir, 'ravel/gone-0000')).toEqual({
        ok: false,
        error: "branch 'ravel/gone-0000' does not exist"
      })
    },
    TIMEOUT
  )
})
