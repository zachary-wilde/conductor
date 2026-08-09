import { describe, expect, test } from 'vitest'
import type { DocumentWorkspaceState } from './documentWorkspace'
import {
  activateDocument,
  applyLoadResult,
  beginSave,
  completeSave,
  createDocumentWorkspace,
  documentKey,
  openDocument,
  requestClose,
  requestSessionDismissal,
  resolveClose,
  resolveSessionDismissal,
  updateDraft
} from './documentWorkspace'

describe('createDocumentWorkspace', () => {
  test('fresh state has empty tabOrderBySession', () => {
    const workspace = createDocumentWorkspace()

    expect(workspace.tabOrderBySession).toEqual({})
  })
})

describe('per-session document visibility and draft survival', () => {
  test('reactivating session a keeps its own tabs, active key, and draft separate from session b', () => {
    const initial = createDocumentWorkspace()

    const aKey = documentKey('a', 'C:\\a\\one.ts')
    const bKey = documentKey('b', 'C:\\b\\two.ts')

    let workspace = openDocument(initial, {
      sessionId: 'a',
      worktreePath: 'C:\\a',
      filePath: 'C:\\a\\one.ts'
    })
    workspace = updateDraft(workspace, aKey, 'unsaved a')
    workspace = openDocument(workspace, {
      sessionId: 'b',
      worktreePath: 'C:\\b',
      filePath: 'C:\\b\\two.ts'
    })
    workspace = activateDocument(workspace, 'a', aKey)

    expect(workspace.tabOrderBySession.a).toEqual([aKey])
    expect(workspace.tabOrderBySession.b).toEqual([bKey])
    expect(workspace.activeKeyBySession.a).toBe(aKey)

    const recordA = workspace.documents.get(aKey)
    expect(recordA?.draft).toBe('unsaved a')
    expect(recordA?.original).toBe('')
  })
})

describe('opening the same session/file twice', () => {
  test('dedupes into a single tab and retains the existing draft', () => {
    const initial = createDocumentWorkspace()

    const key = documentKey('a', 'C:\\a\\one.ts')

    let workspace = openDocument(initial, {
      sessionId: 'a',
      worktreePath: 'C:\\a',
      filePath: 'C:\\a\\one.ts'
    })
    workspace = updateDraft(workspace, key, 'draft')
    workspace = openDocument(workspace, {
      sessionId: 'a',
      worktreePath: 'C:\\a',
      filePath: 'C:\\a\\one.ts'
    })

    expect(workspace.tabOrderBySession.a).toEqual([key])
    expect(workspace.documents.get(key)?.draft).toBe('draft')
  })
})

describe('loadToken determinism', () => {
  test('two independent fresh workspaces given the same open operation produce the same initial loadToken', () => {
    const input = {
      sessionId: 'a',
      worktreePath: 'C:\\a',
      filePath: 'C:\\a\\one.ts'
    }
    const key = documentKey('a', 'C:\\a\\one.ts')

    const workspaceA = openDocument(createDocumentWorkspace(), input)
    const workspaceB = openDocument(createDocumentWorkspace(), input)

    expect(workspaceA.documents.get(key)?.loadToken).toBe(
      workspaceB.documents.get(key)?.loadToken
    )
  })
})

describe('activateDocument session ownership', () => {
  test('activates a key only for the session it belongs to, and no-ops on session mismatch', () => {
    let workspace = openDocument(createDocumentWorkspace(), {
      sessionId: 'a',
      worktreePath: 'C:\\a',
      filePath: 'C:\\a\\one.ts'
    })
    workspace = openDocument(workspace, {
      sessionId: 'a',
      worktreePath: 'C:\\a',
      filePath: 'C:\\a\\two.ts'
    })
    workspace = openDocument(workspace, {
      sessionId: 'b',
      worktreePath: 'C:\\b',
      filePath: 'C:\\b\\three.ts'
    })

    const key1 = documentKey('a', 'C:\\a\\one.ts')
    const key3 = documentKey('b', 'C:\\b\\three.ts')

    const activated = activateDocument(workspace, 'a', key1)
    expect(activated.activeKeyBySession.a).toBe(key1)

    const mismatched = activateDocument(activated, 'b', key1)
    expect(mismatched).toBe(activated)
    expect(mismatched.activeKeyBySession.b).toBe(key3)
  })
})

describe('document path normalization', () => {
  test('same-session paths differing only in drive-letter case and slash direction dedupe to one tab and preserve the draft', () => {
    const initial = createDocumentWorkspace()

    const key = documentKey('a', 'C:\\A\\One.ts')

    let workspace = openDocument(initial, {
      sessionId: 'a',
      worktreePath: 'C:\\A',
      filePath: 'C:\\A\\One.ts'
    })
    workspace = updateDraft(workspace, key, 'unsaved normalization')
    workspace = openDocument(workspace, {
      sessionId: 'a',
      worktreePath: 'c:/a',
      filePath: 'c:/a/one.ts'
    })

    expect(documentKey('a', 'c:/a/one.ts')).toBe(key)
    expect(workspace.tabOrderBySession.a).toEqual([key])
    expect(workspace.documents.size).toBe(1)
    expect(workspace.documents.get(key)?.draft).toBe('unsaved normalization')
  })
})

describe('applyLoadResult', () => {
  test('successful load sets phase ready and original/draft to the loaded text', () => {
    let workspace = openDocument(createDocumentWorkspace(), {
      sessionId: 'a',
      worktreePath: 'C:\\a',
      filePath: 'C:\\a\\one.ts'
    })
    const key = documentKey('a', 'C:\\a\\one.ts')
    const token = workspace.documents.get(key)!.loadToken

    workspace = applyLoadResult(workspace, key, token, 'loaded content')

    const record = workspace.documents.get(key)
    expect(record?.phase).toBe('ready')
    expect(record?.original).toBe('loaded content')
    expect(record?.draft).toBe('loaded content')
  })

  test('null text sets phase to read-error', () => {
    let workspace = openDocument(createDocumentWorkspace(), {
      sessionId: 'a',
      worktreePath: 'C:\\a',
      filePath: 'C:\\a\\one.ts'
    })
    const key = documentKey('a', 'C:\\a\\one.ts')
    const token = workspace.documents.get(key)!.loadToken

    workspace = applyLoadResult(workspace, key, token, null)

    expect(workspace.documents.get(key)?.phase).toBe('read-error')
  })

  test('a stale load token is a no-op that returns the same state', () => {
    const workspace = openDocument(createDocumentWorkspace(), {
      sessionId: 'a',
      worktreePath: 'C:\\a',
      filePath: 'C:\\a\\one.ts'
    })
    const key = documentKey('a', 'C:\\a\\one.ts')
    const token = workspace.documents.get(key)!.loadToken

    const result = applyLoadResult(workspace, key, token + 999, 'ignored')

    expect(result).toBe(workspace)
  })
})

describe('stale load application after close/discard/reopen', () => {
  test('applying the pre-discard load result does not alter the new empty draft, and the reopened token is higher', () => {
    const input = { sessionId: 'a', worktreePath: 'C:\\a', filePath: 'C:\\a\\one.ts' }
    const key = documentKey('a', 'C:\\a\\one.ts')

    let workspace = openDocument(createDocumentWorkspace(), input)
    const firstToken = workspace.documents.get(key)!.loadToken

    workspace = updateDraft(workspace, key, 'dirty edit')
    workspace = requestClose(workspace, key)
    workspace = resolveClose(workspace, 'discard')

    workspace = openDocument(workspace, input)
    const secondToken = workspace.documents.get(key)!.loadToken

    expect(secondToken).toBeGreaterThan(firstToken)

    workspace = applyLoadResult(workspace, key, firstToken, 'stale content')

    const record = workspace.documents.get(key)
    expect(record?.draft).toBe('')
    expect(record?.original).toBe('')
    expect(record?.phase).toBe('loading')
  })
})

describe('in-flight save preserves a point-in-time snapshot', () => {
  test('completing a save applies the snapshot captured at beginSave, not the current draft', () => {
    let workspace = openDocument(createDocumentWorkspace(), {
      sessionId: 'a',
      worktreePath: 'C:\\a',
      filePath: 'C:\\a\\one.ts'
    })
    const key = documentKey('a', 'C:\\a\\one.ts')
    workspace = applyLoadResult(workspace, key, workspace.documents.get(key)!.loadToken, 'base')
    workspace = updateDraft(workspace, key, 'first save')
    workspace = beginSave(workspace, key, 1, 'first save')
    workspace = updateDraft(workspace, key, 'newer edit')

    workspace = completeSave(workspace, key, 1, 'first save', true)

    const record = workspace.documents.get(key)
    expect(record?.original).toBe('first save')
    expect(record?.draft).toBe('newer edit')
    expect(record?.saving).toBe(false)
  })
})

describe('save failure', () => {
  test('preserves original and draft, clears saving, and sets the exact error message', () => {
    let workspace = openDocument(createDocumentWorkspace(), {
      sessionId: 'a',
      worktreePath: 'C:\\a',
      filePath: 'C:\\a\\one.ts'
    })
    const key = documentKey('a', 'C:\\a\\one.ts')
    workspace = applyLoadResult(workspace, key, workspace.documents.get(key)!.loadToken, 'base')
    workspace = updateDraft(workspace, key, 'edited')
    workspace = beginSave(workspace, key, 1, 'edited')

    workspace = completeSave(workspace, key, 1, 'edited', false)

    const record = workspace.documents.get(key)
    expect(record?.original).toBe('base')
    expect(record?.draft).toBe('edited')
    expect(record?.saving).toBe(false)
    expect(record?.saveError).toBe('Save failed — check path and permissions.')
  })

  test('a stale or mismatched completion is a no-op that returns the same state', () => {
    let workspace = openDocument(createDocumentWorkspace(), {
      sessionId: 'a',
      worktreePath: 'C:\\a',
      filePath: 'C:\\a\\one.ts'
    })
    const key = documentKey('a', 'C:\\a\\one.ts')
    workspace = beginSave(workspace, key, 1, 'snapshot')

    const mismatchedRequest = completeSave(workspace, key, 2, 'snapshot', true)
    expect(mismatchedRequest).toBe(workspace)

    const mismatchedSnapshot = completeSave(workspace, key, 1, 'other', true)
    expect(mismatchedSnapshot).toBe(workspace)
  })
})

describe('closing a clean document', () => {
  test('removes it immediately without setting pendingCloseKey', () => {
    let workspace = openDocument(createDocumentWorkspace(), {
      sessionId: 'a',
      worktreePath: 'C:\\a',
      filePath: 'C:\\a\\one.ts'
    })
    const key = documentKey('a', 'C:\\a\\one.ts')

    workspace = requestClose(workspace, key)

    expect(workspace.documents.has(key)).toBe(false)
    expect(workspace.pendingCloseKey).toBeNull()
    expect(workspace.tabOrderBySession.a).toEqual([])
  })

  test('activates the adjacent tab when the closed tab was active', () => {
    let workspace = openDocument(createDocumentWorkspace(), {
      sessionId: 'a',
      worktreePath: 'C:\\a',
      filePath: 'C:\\a\\one.ts'
    })
    workspace = openDocument(workspace, {
      sessionId: 'a',
      worktreePath: 'C:\\a',
      filePath: 'C:\\a\\two.ts'
    })
    workspace = openDocument(workspace, {
      sessionId: 'a',
      worktreePath: 'C:\\a',
      filePath: 'C:\\a\\three.ts'
    })
    const key1 = documentKey('a', 'C:\\a\\one.ts')
    const key2 = documentKey('a', 'C:\\a\\two.ts')
    const key3 = documentKey('a', 'C:\\a\\three.ts')

    workspace = activateDocument(workspace, 'a', key2)
    workspace = requestClose(workspace, key2)

    expect(workspace.documents.has(key2)).toBe(false)
    expect(workspace.tabOrderBySession.a).toEqual([key1, key3])
    expect(workspace.activeKeyBySession.a).toBe(key3)
  })

  test('closing the last remaining tab leaves activeKeyBySession null, not a dangling deleted key', () => {
    let workspace = openDocument(createDocumentWorkspace(), {
      sessionId: 'a',
      worktreePath: 'C:\\a',
      filePath: 'C:\\a\\one.ts'
    })
    const key = documentKey('a', 'C:\\a\\one.ts')

    workspace = requestClose(workspace, key)

    expect(workspace.tabOrderBySession.a).toEqual([])
    expect(workspace.activeKeyBySession.a).toBeNull()
  })
})

describe('closing a dirty document', () => {
  test('requires a pending decision: sets pendingCloseKey and keeps the document with its draft', () => {
    let workspace = openDocument(createDocumentWorkspace(), {
      sessionId: 'a',
      worktreePath: 'C:\\a',
      filePath: 'C:\\a\\one.ts'
    })
    const key = documentKey('a', 'C:\\a\\one.ts')
    workspace = updateDraft(workspace, key, 'dirty')

    workspace = requestClose(workspace, key)

    expect(workspace.pendingCloseKey).toBe(key)
    expect(workspace.documents.has(key)).toBe(true)
    expect(workspace.documents.get(key)?.draft).toBe('dirty')
  })

  test('cancel clears pendingCloseKey and preserves the dirty draft', () => {
    let workspace = openDocument(createDocumentWorkspace(), {
      sessionId: 'a',
      worktreePath: 'C:\\a',
      filePath: 'C:\\a\\one.ts'
    })
    const key = documentKey('a', 'C:\\a\\one.ts')
    workspace = updateDraft(workspace, key, 'dirty')
    workspace = requestClose(workspace, key)

    workspace = resolveClose(workspace, 'cancel')

    expect(workspace.pendingCloseKey).toBeNull()
    expect(workspace.documents.has(key)).toBe(true)
    expect(workspace.documents.get(key)?.draft).toBe('dirty')
  })

  test('discard removes the pending document', () => {
    let workspace = openDocument(createDocumentWorkspace(), {
      sessionId: 'a',
      worktreePath: 'C:\\a',
      filePath: 'C:\\a\\one.ts'
    })
    const key = documentKey('a', 'C:\\a\\one.ts')
    workspace = updateDraft(workspace, key, 'dirty')
    workspace = requestClose(workspace, key)

    workspace = resolveClose(workspace, 'discard')

    expect(workspace.pendingCloseKey).toBeNull()
    expect(workspace.documents.has(key)).toBe(false)
  })

  test('save-success removes the pending document', () => {
    let workspace = openDocument(createDocumentWorkspace(), {
      sessionId: 'a',
      worktreePath: 'C:\\a',
      filePath: 'C:\\a\\one.ts'
    })
    const key = documentKey('a', 'C:\\a\\one.ts')
    workspace = updateDraft(workspace, key, 'dirty')
    workspace = requestClose(workspace, key)

    workspace = resolveClose(workspace, 'save-success')

    expect(workspace.pendingCloseKey).toBeNull()
    expect(workspace.documents.has(key)).toBe(false)
  })
})

describe('session dismissal', () => {
  function openThreeDocsInSessionA(): {
    workspace: DocumentWorkspaceState
    key1: string
    key2: string
    key3: string
  } {
    let workspace = openDocument(createDocumentWorkspace(), {
      sessionId: 'a',
      worktreePath: 'C:\\a',
      filePath: 'C:\\a\\one.ts'
    })
    workspace = openDocument(workspace, {
      sessionId: 'a',
      worktreePath: 'C:\\a',
      filePath: 'C:\\a\\two.ts'
    })
    workspace = openDocument(workspace, {
      sessionId: 'a',
      worktreePath: 'C:\\a',
      filePath: 'C:\\a\\three.ts'
    })
    return {
      workspace,
      key1: documentKey('a', 'C:\\a\\one.ts'),
      key2: documentKey('a', 'C:\\a\\two.ts'),
      key3: documentKey('a', 'C:\\a\\three.ts')
    }
  }

  test('reports dirty keys for the session in tab order', () => {
    const { workspace: base, key1, key3 } = openThreeDocsInSessionA()
    let workspace = updateDraft(base, key1, 'dirty1')
    workspace = updateDraft(workspace, key3, 'dirty3')

    const result = requestSessionDismissal(workspace, 'a')

    expect(result.dirtyKeys).toEqual([key1, key3])
  })

  test('a cancel decision for any dirty key returns the same state unchanged', () => {
    const { workspace: base, key1, key3 } = openThreeDocsInSessionA()
    let workspace = updateDraft(base, key1, 'dirty1')
    workspace = updateDraft(workspace, key3, 'dirty3')

    const decisions = new Map<string, 'save-success' | 'discard' | 'cancel'>([
      [key1, 'discard'],
      [key3, 'cancel']
    ])
    const resolved = resolveSessionDismissal(workspace, 'a', decisions)

    expect(resolved).toBe(workspace)
  })

  test('keeps two dirty documents when sequential decisions are discard then cancel', () => {
    const { workspace: base, key1, key2 } = openThreeDocsInSessionA()
    let workspace = updateDraft(base, key1, 'dirty one')
    workspace = updateDraft(workspace, key2, 'dirty two')

    const resolved = resolveSessionDismissal(workspace, 'a', new Map([
      [key1, 'discard'],
      [key2, 'cancel']
    ]))

    expect(resolved).toBe(workspace)
    expect(resolved.documents.get(key1)?.draft).toBe('dirty one')
    expect(resolved.documents.get(key2)?.draft).toBe('dirty two')
  })

  test('a missing decision for a dirty key returns the same state unchanged', () => {
    const { workspace: base, key1, key3 } = openThreeDocsInSessionA()
    let workspace = updateDraft(base, key1, 'dirty1')
    workspace = updateDraft(workspace, key3, 'dirty3')

    const decisions = new Map<string, 'save-success' | 'discard' | 'cancel'>([[key1, 'discard']])
    const resolved = resolveSessionDismissal(workspace, 'a', decisions)

    expect(resolved).toBe(workspace)
  })

  test('all discard/save-success decisions prune the session docs, tab order, and active index, leaving other sessions intact', () => {
    const { workspace: base, key1, key2 } = openThreeDocsInSessionA()
    let workspace = openDocument(base, {
      sessionId: 'b',
      worktreePath: 'C:\\b',
      filePath: 'C:\\b\\other.ts'
    })
    const keyB = documentKey('b', 'C:\\b\\other.ts')
    workspace = updateDraft(workspace, key1, 'dirty1')

    const decisions = new Map<string, 'save-success' | 'discard' | 'cancel'>([[key1, 'save-success']])
    const resolved = resolveSessionDismissal(workspace, 'a', decisions)

    expect(resolved.documents.has(key1)).toBe(false)
    expect(resolved.documents.has(key2)).toBe(false)
    expect(resolved.tabOrderBySession.a).toBeUndefined()
    expect(resolved.activeKeyBySession.a).toBeUndefined()
    expect(resolved.documents.has(keyB)).toBe(true)
    expect(resolved.tabOrderBySession.b).toEqual([keyB])
    expect(resolved.activeKeyBySession.b).toBe(keyB)
  })

  test('dismissing the session owning the pending close key clears it, while an unrelated session leaves it untouched', () => {
    const { workspace: base, key1 } = openThreeDocsInSessionA()
    let workspace = updateDraft(base, key1, 'dirty1')
    workspace = requestClose(workspace, key1)
    expect(workspace.pendingCloseKey).toBe(key1)

    const otherSessionWorkspace = openDocument(workspace, {
      sessionId: 'b',
      worktreePath: 'C:\\b',
      filePath: 'C:\\b\\other.ts'
    })

    const decisionsForOtherSession = new Map<string, 'save-success' | 'discard' | 'cancel'>()
    const resolvedOtherSession = resolveSessionDismissal(otherSessionWorkspace, 'b', decisionsForOtherSession)
    expect(resolvedOtherSession.pendingCloseKey).toBe(key1)

    const decisionsForOwningSession = new Map<string, 'save-success' | 'discard' | 'cancel'>([
      [key1, 'discard']
    ])
    const resolvedOwningSession = resolveSessionDismissal(workspace, 'a', decisionsForOwningSession)
    expect(resolvedOwningSession.pendingCloseKey).toBeNull()
  })
})

describe('explicit request tokens and save starts', () => {
  test('uses a supplied load token and keeps nextLoadToken monotonic', () => {
    const input = {
      sessionId: 'a',
      worktreePath: 'C:\\a',
      filePath: 'C:\\a\\one.ts'
    }
    const key = documentKey('a', input.filePath)

    let workspace = openDocument(createDocumentWorkspace(), input, 41)
    expect(workspace.documents.get(key)?.loadToken).toBe(41)
    expect(workspace.nextLoadToken).toBe(42)

    workspace = openDocument(workspace, {
      sessionId: 'a',
      worktreePath: 'C:\\a',
      filePath: 'C:\\a\\two.ts'
    }, 7)
    expect(workspace.nextLoadToken).toBe(42)
  })

  test('does not replace an in-flight save request', () => {
    const input = {
      sessionId: 'a',
      worktreePath: 'C:\\a',
      filePath: 'C:\\a\\one.ts'
    }
    const key = documentKey('a', input.filePath)
    const opened = openDocument(createDocumentWorkspace(), input)
    const saving = beginSave(opened, key, 1, 'first snapshot')
    const repeated = beginSave(saving, key, 2, 'second snapshot')

    expect(repeated).toBe(saving)
    expect(repeated.documents.get(key)?.saveRequestId).toBe(1)
    expect(repeated.documents.get(key)?.saveSnapshot).toBe('first snapshot')
  })
})
