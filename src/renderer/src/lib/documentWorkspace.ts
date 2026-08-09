export type DocumentKey = string

export type DocumentPhase = 'loading' | 'ready' | 'read-error'

export interface DocumentRecord {
  key: DocumentKey
  sessionId: string
  worktreePath: string
  filePath: string
  phase: DocumentPhase
  original: string
  draft: string
  saving: boolean
  saveRequestId: number | null
  saveSnapshot: string | null
  saveError: string | null
  loadToken: number
}

export interface DocumentWorkspaceState {
  documents: Map<DocumentKey, DocumentRecord>
  tabOrderBySession: Record<string, DocumentKey[]>
  activeKeyBySession: Record<string, DocumentKey | null>
  pendingCloseKey: DocumentKey | null
  nextLoadToken: number
}

export interface OpenDocumentInput {
  sessionId: string
  worktreePath: string
  filePath: string
}

export function documentKey(sessionId: string, filePath: string): DocumentKey {
  return `${sessionId}::${filePath.replace(/\\/g, '/').toLowerCase()}`
}

export function createDocumentWorkspace(): DocumentWorkspaceState {
  return {
    documents: new Map(),
    tabOrderBySession: {},
    activeKeyBySession: {},
    pendingCloseKey: null,
    nextLoadToken: 1
  }
}

export function openDocument(
  state: DocumentWorkspaceState,
  input: OpenDocumentInput,
  suppliedLoadToken?: number
): DocumentWorkspaceState {
  const key = documentKey(input.sessionId, input.filePath)

  if (state.documents.has(key)) {
    return activateDocument(state, input.sessionId, key)
  }

  const loadToken = suppliedLoadToken ?? state.nextLoadToken

  const record: DocumentRecord = {
    key,
    sessionId: input.sessionId,
    worktreePath: input.worktreePath,
    filePath: input.filePath,
    phase: 'loading',
    original: '',
    draft: '',
    saving: false,
    saveRequestId: null,
    saveSnapshot: null,
    saveError: null,
    loadToken
  }

  const documents = new Map(state.documents)
  documents.set(key, record)

  const existingOrder = state.tabOrderBySession[input.sessionId] ?? []
  const tabOrderBySession = {
    ...state.tabOrderBySession,
    [input.sessionId]: [...existingOrder, key]
  }

  const activeKeyBySession = {
    ...state.activeKeyBySession,
    [input.sessionId]: key
  }

  return {
    ...state,
    documents,
    tabOrderBySession,
    activeKeyBySession,
    nextLoadToken: Math.max(state.nextLoadToken, loadToken + 1)
  }
}

export function activateDocument(
  state: DocumentWorkspaceState,
  sessionId: string,
  key: DocumentKey
): DocumentWorkspaceState {
  const record = state.documents.get(key)
  if (!record || record.sessionId !== sessionId) {
    return state
  }

  if (state.activeKeyBySession[sessionId] === key) {
    return state
  }

  return {
    ...state,
    activeKeyBySession: {
      ...state.activeKeyBySession,
      [sessionId]: key
    }
  }
}

export function updateDraft(
  state: DocumentWorkspaceState,
  key: DocumentKey,
  draft: string
): DocumentWorkspaceState {
  const record = state.documents.get(key)
  if (!record) {
    return state
  }

  if (record.draft === draft) {
    return state
  }

  const documents = new Map(state.documents)
  documents.set(key, { ...record, draft })

  return {
    ...state,
    documents
  }
}

export type CloseDecision = 'save-success' | 'discard' | 'cancel'

export function applyLoadResult(
  state: DocumentWorkspaceState,
  key: DocumentKey,
  token: number,
  text: string | null
): DocumentWorkspaceState {
  const record = state.documents.get(key)
  if (!record || record.loadToken !== token) {
    return state
  }

  const updated: DocumentRecord =
    text === null ? { ...record, phase: 'read-error' } : { ...record, phase: 'ready', original: text, draft: text }

  const documents = new Map(state.documents)
  documents.set(key, updated)

  return {
    ...state,
    documents
  }
}

export function beginSave(
  state: DocumentWorkspaceState,
  key: DocumentKey,
  requestId: number,
  snapshot: string
): DocumentWorkspaceState {
  const record = state.documents.get(key)
  if (!record) {
    return state
  }
  if (record.saving) {
    return state
  }

  const documents = new Map(state.documents)
  documents.set(key, {
    ...record,
    saving: true,
    saveRequestId: requestId,
    saveSnapshot: snapshot,
    saveError: null
  })

  return {
    ...state,
    documents
  }
}

export function completeSave(
  state: DocumentWorkspaceState,
  key: DocumentKey,
  requestId: number,
  snapshot: string,
  ok: boolean
): DocumentWorkspaceState {
  const record = state.documents.get(key)
  if (!record || record.saveRequestId !== requestId || record.saveSnapshot !== snapshot) {
    return state
  }

  const documents = new Map(state.documents)
  documents.set(key, {
    ...record,
    saving: false,
    saveRequestId: null,
    saveSnapshot: null,
    original: ok ? snapshot : record.original,
    saveError: ok ? null : 'Save failed — check path and permissions.'
  })

  return {
    ...state,
    documents
  }
}

function removeDocument(state: DocumentWorkspaceState, key: DocumentKey): DocumentWorkspaceState {
  const record = state.documents.get(key)
  if (!record) {
    return state
  }

  const documents = new Map(state.documents)
  documents.delete(key)

  const sessionId = record.sessionId
  const oldOrder = state.tabOrderBySession[sessionId] ?? []
  const removedIndex = oldOrder.indexOf(key)
  const newOrder = oldOrder.filter((candidate) => candidate !== key)
  const tabOrderBySession = {
    ...state.tabOrderBySession,
    [sessionId]: newOrder
  }

  let activeKeyBySession = state.activeKeyBySession
  if (state.activeKeyBySession[sessionId] === key) {
    const adjacentIndex = removedIndex < newOrder.length ? removedIndex : newOrder.length - 1
    const nextActive = adjacentIndex >= 0 ? newOrder[adjacentIndex] : null
    activeKeyBySession = {
      ...state.activeKeyBySession,
      [sessionId]: nextActive
    }
  }

  const pendingCloseKey = state.pendingCloseKey === key ? null : state.pendingCloseKey

  return {
    ...state,
    documents,
    tabOrderBySession,
    activeKeyBySession,
    pendingCloseKey
  }
}

export function requestClose(state: DocumentWorkspaceState, key: DocumentKey): DocumentWorkspaceState {
  const record = state.documents.get(key)
  if (!record) {
    return state
  }

  if (record.draft === record.original) {
    return removeDocument(state, key)
  }

  if (state.pendingCloseKey === key) {
    return state
  }

  return {
    ...state,
    pendingCloseKey: key
  }
}

export function resolveClose(state: DocumentWorkspaceState, choice: CloseDecision): DocumentWorkspaceState {
  const key = state.pendingCloseKey
  if (!key) {
    return state
  }

  if (choice === 'cancel') {
    return {
      ...state,
      pendingCloseKey: null
    }
  }

  return removeDocument(state, key)
}

export interface SessionDismissalRequest {
  dirtyKeys: DocumentKey[]
}

export function requestSessionDismissal(state: DocumentWorkspaceState, sessionId: string): SessionDismissalRequest {
  const order = state.tabOrderBySession[sessionId] ?? []
  const dirtyKeys = order.filter((key) => {
    const record = state.documents.get(key)
    return record !== undefined && record.draft !== record.original
  })

  return { dirtyKeys }
}

export function resolveSessionDismissal(
  state: DocumentWorkspaceState,
  sessionId: string,
  decisions: Map<DocumentKey, CloseDecision>
): DocumentWorkspaceState {
  const { dirtyKeys } = requestSessionDismissal(state, sessionId)
  const allResolved = dirtyKeys.every((key) => {
    const decision = decisions.get(key)
    return decision === 'save-success' || decision === 'discard'
  })

  if (!allResolved) {
    return state
  }

  const order = state.tabOrderBySession[sessionId] ?? []
  const documents = new Map(state.documents)
  for (const key of order) {
    documents.delete(key)
  }

  const tabOrderBySession = { ...state.tabOrderBySession }
  delete tabOrderBySession[sessionId]

  const activeKeyBySession = { ...state.activeKeyBySession }
  delete activeKeyBySession[sessionId]

  const pendingRecord = state.pendingCloseKey ? state.documents.get(state.pendingCloseKey) : undefined
  const pendingCloseKey = pendingRecord?.sessionId === sessionId ? null : state.pendingCloseKey

  return {
    ...state,
    documents,
    tabOrderBySession,
    activeKeyBySession,
    pendingCloseKey
  }
}
