import { describe, expect, test } from 'vitest'
import type { Repo } from '@shared/types'
import {
  invalidRavelRequest,
  parseCreateNormalSessionRequest,
  parseCreateRavelRequest,
  parseRavelBriefMutation,
  parseRavelMessage,
  parseUpdateRavelBriefAssignment,
  ravelReadFallback
} from './ravel-ipc'

const repo: Repo = {
  id: 'repo-1',
  name: 'Repo',
  path: 'D:/Work/Repo',
  addedAt: 1
}

function expectInvalid(result: { ok: boolean; error?: { code: string; message?: string } }, text: string): void {
  expect(result.ok).toBe(false)
  expect(result.error).toMatchObject({ code: 'invalid-request' })
  expect(result.error?.message).toContain(text)
}

describe('parseCreateNormalSessionRequest', () => {
  test('sanitizes a normal public session request and ignores unprivileged extras', () => {
    const result = parseCreateNormalSessionRequest({
      repoId: 'repo-1',
      repoPath: 'D:/repo',
      worktreePath: 'D:/repo',
      branch: 'main',
      harness: 'claude',
      initialPrompt: 'hello',
      kind: 'normal',
      ignored: 'not copied'
    })

    expect(result).toEqual({
      ok: true,
      value: {
        repoId: 'repo-1',
        repoPath: 'D:/repo',
        worktreePath: 'D:/repo',
        branch: 'main',
        harness: 'claude',
        initialPrompt: 'hello',
        kind: 'normal'
      }
    })
  })

  test.each(['parentId', 'ravelId', 'ravelRole', 'briefId', 'autoApprove', 'env'])(
    'rejects privileged public session field %s',
    (field) => {
      const result = parseCreateNormalSessionRequest({
        repoId: 'repo-1',
        repoPath: 'D:/repo',
        worktreePath: 'D:/repo',
        branch: 'main',
        harness: 'claude',
        [field]: field === 'autoApprove' ? true : 'secret'
      })

      expectInvalid(result, field)
    }
  )

  test('rejects non-normal session kinds before runtime creation', () => {
    const result = parseCreateNormalSessionRequest({
      repoId: 'repo-1',
      repoPath: 'D:/repo',
      worktreePath: 'D:/repo',
      branch: 'main',
      harness: 'claude',
      kind: 'ravel-child'
    })

    expectInvalid(result, 'kind')
  })

  /**
   * A terminal session runs the operator's shell. It is the ONLY place a null
   * harness is accepted — a ravel brief or roundtable seat handed a shell would
   * be dispatched to something the manager cannot invoke.
   */
  test('accepts a null harness as a terminal session', () => {
    const result = parseCreateNormalSessionRequest({
      repoId: 'repo-1',
      repoPath: 'D:/repo',
      worktreePath: 'D:/repo',
      branch: 'main',
      harness: null,
      title: 'Scratch'
    })

    expect(result).toEqual({
      ok: true,
      value: {
        repoId: 'repo-1',
        repoPath: 'D:/repo',
        worktreePath: 'D:/repo',
        branch: 'main',
        harness: null
      }
    })
  })

  test('refuses an initial prompt on a terminal: a shell would execute it', () => {
    const result = parseCreateNormalSessionRequest({
      repoId: 'repo-1',
      repoPath: 'D:/repo',
      worktreePath: 'D:/repo',
      branch: 'main',
      harness: null,
      initialPrompt: 'rm -rf /'
    })

    expectInvalid(result, 'initial prompt')
  })

  test('refuses a model on a terminal: no agent is running to honour it', () => {
    const result = parseCreateNormalSessionRequest({
      repoId: 'repo-1',
      repoPath: 'D:/repo',
      worktreePath: 'D:/repo',
      branch: 'main',
      harness: null,
      model: 'opus'
    })

    expectInvalid(result, 'model')
  })

  test.each([undefined, 'shell', 'bash', 'CLAUDE', 7, {}])(
    'still rejects %p as a harness',
    (value) => {
      const result = parseCreateNormalSessionRequest({
        repoId: 'repo-1',
        repoPath: 'D:/repo',
        worktreePath: 'D:/repo',
        branch: 'main',
        harness: value
      })

      expectInvalid(result, 'harness')
    }
  )
})

describe('parseCreateRavelRequest', () => {
  test('validates and canonicalizes create requests to the tracked repo path', () => {
    const result = parseCreateRavelRequest(
      {
        name: 'Ravel',
        repoId: 'repo-1',
        repoPath: 'd:/work/repo/.',
        harness: 'codex',
        initialInstruction: 'Plan this',
        maxChildren: 8,
        allowRisky: false,
        // The pulse interval is gone; an old renderer sending one must not have it echoed back.
        pulseSeconds: 120
      },
      [repo]
    )

    expect(result).toEqual({
      ok: true,
      value: {
        name: 'Ravel',
        repoId: 'repo-1',
        repoPath: repo.path,
        harness: 'codex',
        initialInstruction: 'Plan this',
        maxChildren: 8,
        allowRisky: false
      }
    })
  })

  test('rejects unknown repo IDs and path mismatches', () => {
    expectInvalid(
      parseCreateRavelRequest({ name: 'Ravel', repoId: 'missing', repoPath: repo.path, harness: 'claude' }, [repo]),
      'repoId'
    )
    expectInvalid(
      parseCreateRavelRequest({ name: 'Ravel', repoId: repo.id, repoPath: 'D:/Other', harness: 'claude' }, [repo]),
      'repoPath'
    )
  })

  test('rejects malformed create options', () => {
    expectInvalid(
      parseCreateRavelRequest({ name: 'Ravel', repoId: repo.id, repoPath: repo.path, harness: 'bogus' }, [repo]),
      'harness'
    )
    expectInvalid(
      parseCreateRavelRequest({ name: 'Ravel', repoId: repo.id, repoPath: repo.path, harness: 'claude', maxChildren: 3 }, [repo]),
      'maxChildren'
    )
  })
})

describe('Ravel mutation validators', () => {
  test('validates ids, bodies, revisions, and brief IDs for mutation handlers', () => {
    expect(parseRavelMessage('ravel-1', 'hello')).toEqual({ ok: true, value: { id: 'ravel-1', body: 'hello' } })
    expect(parseRavelBriefMutation('ravel-1', 2, 'brief-1')).toEqual({
      ok: true,
      value: { id: 'ravel-1', planRevision: 2, briefId: 'brief-1' }
    })

    expectInvalid(parseRavelMessage('', 'hello'), 'id')
    expectInvalid(parseRavelMessage('ravel-1', ''), 'body')
    expectInvalid(parseRavelBriefMutation('ravel-1', 0, 'brief-1'), 'planRevision')
    expectInvalid(parseRavelBriefMutation('ravel-1', 1, ''), 'briefId')
  })

  test('validates brief assignment shape, roles, harnesses, and non-empty patches', () => {
    expect(parseUpdateRavelBriefAssignment('ravel-1', 3, 'brief-1', { role: 'auditor' })).toEqual({
      ok: true,
      value: { id: 'ravel-1', planRevision: 3, briefId: 'brief-1', assignment: { role: 'auditor' } }
    })
    expect(parseUpdateRavelBriefAssignment('ravel-1', 3, 'brief-1', { harness: 'zai' })).toEqual({
      ok: true,
      value: { id: 'ravel-1', planRevision: 3, briefId: 'brief-1', assignment: { harness: 'zai' } }
    })

    expectInvalid(parseUpdateRavelBriefAssignment('ravel-1', 3, 'brief-1', {}), 'assignment')
    expectInvalid(parseUpdateRavelBriefAssignment('ravel-1', 3, 'brief-1', { role: 'orchestrator' }), 'role')
    expectInvalid(parseUpdateRavelBriefAssignment('ravel-1', 3, 'brief-1', { harness: 'bogus' }), 'harness')
    expectInvalid(parseUpdateRavelBriefAssignment('ravel-1', 3, 'brief-1', { role: 'auditor', capSecret: 'x' }), 'assignment')
  })

  test('accepts a trimmed model override and an explicit null clear, rejecting blanks', () => {
    expect(parseUpdateRavelBriefAssignment('ravel-1', 3, 'brief-1', { model: '  opus  ' })).toEqual({
      ok: true,
      value: { id: 'ravel-1', planRevision: 3, briefId: 'brief-1', assignment: { model: 'opus' } }
    })
    expect(parseUpdateRavelBriefAssignment('ravel-1', 3, 'brief-1', { model: null })).toEqual({
      ok: true,
      value: { id: 'ravel-1', planRevision: 3, briefId: 'brief-1', assignment: { model: null } }
    })

    expectInvalid(parseUpdateRavelBriefAssignment('ravel-1', 3, 'brief-1', { model: '   ' }), 'model')
    expectInvalid(parseUpdateRavelBriefAssignment('ravel-1', 3, 'brief-1', { model: 7 }), 'model')
  })

  test('accepts an empty worktree path only when a worktree is created at launch', () => {
    const base = { repoId: 'r', repoPath: 'D:/repo', branch: 'feat/x', harness: 'claude' }
    const deferred = parseCreateNormalSessionRequest({
      ...base,
      worktreePath: '',
      createWorktree: { repoPath: 'D:/repo', branch: 'feat/x', newBranch: true }
    })
    expect(deferred.ok).toBe(true)

    expectInvalid(parseCreateNormalSessionRequest({ ...base, worktreePath: '' }), 'worktreePath')
  })

  test('converts malformed Ravel IPC into bounded action results', () => {
    expect(invalidRavelRequest({ code: 'invalid-request', message: 'bad payload' })).toEqual({
      ok: false,
      error: { code: 'invalid-request', message: 'bad payload' }
    })
  })

  test('preserves non-action read shapes for malformed ids', () => {
    expect(ravelReadFallback('get')).toBeNull()
    expect(ravelReadFallback('log')).toEqual([])
    expect(ravelReadFallback('children')).toEqual([])
  })
})
