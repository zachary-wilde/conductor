import {
  createContext,
  useContext,
  useEffect,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from 'react'
import { Circle } from 'lucide-react'
import { useStore } from '../store/useStore'
import { basename } from '../lib/path'
import { CodeEditor } from './CodeEditor'
import {
  activateDocument,
  applyLoadResult,
  beginSave,
  completeSave,
  createDocumentWorkspace,
  openDocument as openDocumentState,
  requestClose,
  requestSessionDismissal as requestDismissalState,
  resolveClose,
  resolveSessionDismissal,
  updateDraft,
  type DocumentKey,
  type DocumentWorkspaceState,
  type OpenDocumentInput
} from '../lib/documentWorkspace'

type Action =
  | { type: 'open'; input: OpenDocumentInput; token: number }
  | { type: 'activate'; sessionId: string; key: DocumentKey }
  | { type: 'load-result'; key: DocumentKey; token: number; text: string | null }
  | { type: 'draft'; key: DocumentKey; draft: string }
  | { type: 'save-start'; key: DocumentKey; requestId: number; snapshot: string }
  | { type: 'save-result'; key: DocumentKey; requestId: number; snapshot: string; ok: boolean }
  | { type: 'close-request'; key: DocumentKey }
  | { type: 'close-resolve'; choice: 'save-success' | 'discard' | 'cancel' }
  | { type: 'dismiss-resolve'; sessionId: string; decisions: Map<DocumentKey, 'save-success' | 'discard' | 'cancel'> }

function reducer(state: DocumentWorkspaceState, action: Action): DocumentWorkspaceState {
  switch (action.type) {
    case 'open': return openDocumentState(state, action.input, action.token)
    case 'activate': return activateDocument(state, action.sessionId, action.key)
    case 'load-result': return applyLoadResult(state, action.key, action.token, action.text)
    case 'draft': return updateDraft(state, action.key, action.draft)
    case 'save-start': return beginSave(state, action.key, action.requestId, action.snapshot)
    case 'save-result': return completeSave(state, action.key, action.requestId, action.snapshot, action.ok)
    case 'close-request': return requestClose(state, action.key)
    case 'close-resolve': return resolveClose(state, action.choice)
    case 'dismiss-resolve': return resolveSessionDismissal(state, action.sessionId, action.decisions)
  }
}

interface DocumentWorkspaceApi {
  state: DocumentWorkspaceState
  openDocument: (input: OpenDocumentInput) => void
  selectDocument: (sessionId: string, key: DocumentKey) => void
  updateDocumentDraft: (key: DocumentKey, draft: string) => void
  saveDocument: (key: DocumentKey) => Promise<boolean>
  requestCloseDocument: (key: DocumentKey) => void
  resolveCloseDocument: (choice: 'save-success' | 'discard' | 'cancel') => void
  requestSessionDismissal: (sessionId: string) => Promise<boolean>
}

const DocumentWorkspaceContext = createContext<DocumentWorkspaceApi | null>(null)

type DismissChoice = 'save' | 'discard' | 'cancel'

interface DismissalPrompt {
  sessionId: string
  key: DocumentKey
  filePath: string
}

function trapModalFocus(event: ReactKeyboardEvent<HTMLDivElement>): void {
  if (event.key !== 'Tab') return
  const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled])'))
  if (controls.length === 0) {
    event.preventDefault()
    event.currentTarget.focus()
    return
  }
  const current = document.activeElement
  const index = controls.indexOf(current as HTMLElement)
  if (event.shiftKey && index <= 0) {
    event.preventDefault()
    controls[controls.length - 1].focus()
  } else if (!event.shiftKey && index === controls.length - 1) {
    event.preventDefault()
    controls[0].focus()
  }
}

export function useDocumentWorkspace(): DocumentWorkspaceApi {
  const value = useContext(DocumentWorkspaceContext)
  if (!value) throw new Error('useDocumentWorkspace must be used within DocumentWorkspaceProvider')
  return value
}

export function DocumentWorkspaceProvider({ children }: { children: ReactNode }): JSX.Element {
  const [state, dispatch] = useReducer(reducer, undefined, createDocumentWorkspace)
  const dismissSession = useStore((s) => s.dismissSession)
  const stateRef = useRef(state)
  stateRef.current = state
  const dismissalCancelRef = useRef<HTMLButtonElement>(null)
  const dismissalDialogRef = useRef<HTMLDivElement>(null)
  const [dismissalPrompt, setDismissalPrompt] = useState<DismissalPrompt | null>(null)
  const dismissalSaving = dismissalPrompt ? state.documents.get(dismissalPrompt.key)?.saving === true : false
  const loadTokenRef = useRef(0)
  const saveRequestRef = useRef(0)
  const loadRequests = useRef(new Set<string>())
  const saveRequests = useRef(new Set<string>())
  const saveResolvers = useRef(new Map<string, (ok: boolean) => void>())
  const savePromises = useRef(new Map<DocumentKey, Promise<boolean>>())
  const dismissalInFlight = useRef(new Map<string, Promise<boolean>>())
  const activeDismissalPrompt = useRef<{ prompt: DismissalPrompt; resolve: (choice: DismissChoice) => void } | null>(null)
  const dismissalPromptQueue = useRef<Array<{ prompt: DismissalPrompt; resolve: (choice: DismissChoice) => void }>>([])

  useEffect(() => {
    for (const document of state.documents.values()) {
      if (document.phase !== 'loading') continue
      const requestKey = `${document.key}:${document.loadToken}`
      if (loadRequests.current.has(requestKey)) continue
      loadRequests.current.add(requestKey)
      const { key, loadToken, filePath } = document
      void window.api.readFile(filePath).then(
        (text) => dispatch({ type: 'load-result', key, token: loadToken, text }),
        () => dispatch({ type: 'load-result', key, token: loadToken, text: null })
      )
    }
  }, [state.documents])

  useEffect(() => {
    for (const document of state.documents.values()) {
      if (!document.saving || document.saveRequestId === null || document.saveSnapshot === null) continue
      const requestKey = `${document.key}:${document.saveRequestId}`
      if (saveRequests.current.has(requestKey)) continue
      saveRequests.current.add(requestKey)
      const { key, filePath, saveRequestId, saveSnapshot } = document
      void window.api.writeFile(filePath, saveSnapshot).then(
        (ok) => {
          dispatch({ type: 'save-result', key, requestId: saveRequestId, snapshot: saveSnapshot, ok })
          saveResolvers.current.get(requestKey)?.(ok)
          saveResolvers.current.delete(requestKey)
          savePromises.current.delete(key)
        },
        () => {
          dispatch({ type: 'save-result', key, requestId: saveRequestId, snapshot: saveSnapshot, ok: false })
          saveResolvers.current.get(requestKey)?.(false)
          saveResolvers.current.delete(requestKey)
          savePromises.current.delete(key)
        }
      )
    }

  }, [state.documents])

  useEffect(() => {
    if (!dismissalPrompt) return
    if (dismissalSaving) dismissalDialogRef.current?.focus()
    else dismissalCancelRef.current?.focus()
  }, [dismissalPrompt, dismissalSaving])

  useEffect(() => () => {
    for (const resolve of saveResolvers.current.values()) resolve(false)
    activeDismissalPrompt.current?.resolve('cancel')
    for (const pending of dismissalPromptQueue.current) pending.resolve('cancel')
    loadRequests.current.clear()
    saveRequests.current.clear()
    saveResolvers.current.clear()
    savePromises.current.clear()
    dismissalInFlight.current.clear()
    activeDismissalPrompt.current = null
    dismissalPromptQueue.current = []
  }, [])

  const presentDismissalPrompt = (prompt: DismissalPrompt): Promise<DismissChoice> => {
    const { promise, resolve } = Promise.withResolvers<DismissChoice>()
    const request = { prompt, resolve }
    if (activeDismissalPrompt.current) {
      dismissalPromptQueue.current.push(request)
    } else {
      activeDismissalPrompt.current = request
      setDismissalPrompt(prompt)
    }
    return promise
  }

  const answerDismissalPrompt = (choice: DismissChoice): void => {
    const active = activeDismissalPrompt.current
    if (!active) return
    activeDismissalPrompt.current = null
    active.resolve(choice)
    const next = dismissalPromptQueue.current.shift() ?? null
    activeDismissalPrompt.current = next
    setDismissalPrompt(next?.prompt ?? null)
  }

  const cleanupSessionRequests = (keys: DocumentKey[]): void => {
    for (const key of keys) {
      const prefix = `${key}:`
      for (const requestKey of loadRequests.current) {
        if (requestKey.startsWith(prefix)) loadRequests.current.delete(requestKey)
      }
      for (const requestKey of saveRequests.current) {
        if (requestKey.startsWith(prefix)) saveRequests.current.delete(requestKey)
      }
      for (const [requestKey, resolve] of saveResolvers.current) {
        if (!requestKey.startsWith(prefix)) continue
        resolve(false)
        saveResolvers.current.delete(requestKey)
      }
      savePromises.current.delete(key)
    }
  }

  const saveDocument = (key: DocumentKey): Promise<boolean> => {
    const inFlight = savePromises.current.get(key)
    if (inFlight) return inFlight
    const document = stateRef.current.documents.get(key)
    if (!document || document.saving || document.draft === document.original) return Promise.resolve(true)
    const requestId = ++saveRequestRef.current
    const snapshot = document.draft
    const requestKey = `${key}:${requestId}`
    const { promise, resolve } = Promise.withResolvers<boolean>()
    saveResolvers.current.set(requestKey, resolve)
    savePromises.current.set(key, promise)
    dispatch({ type: 'save-start', key, requestId, snapshot })
    return promise
  }

  const requestSessionDismissal = (sessionId: string): Promise<boolean> => {
    const inFlight = dismissalInFlight.current.get(sessionId)
    if (inFlight) return inFlight

    const dismissal = (async (): Promise<boolean> => {
      const decisions = new Map<DocumentKey, 'save-success' | 'discard' | 'cancel'>()
      const dirtyKeys = requestDismissalState(stateRef.current, sessionId).dirtyKeys

      for (const key of dirtyKeys) {
        const document = stateRef.current.documents.get(key)
        if (!document) return false
        const choice = await presentDismissalPrompt({ sessionId, key, filePath: document.filePath })
        if (choice === 'cancel') return false
        if (choice === 'save') {
          let saved = false
          try {
            saved = await saveDocument(key)
          } catch {
            saved = false
          }
          if (!saved) return false
          decisions.set(key, 'save-success')
        } else {
          decisions.set(key, 'discard')
        }
      }

      const current = stateRef.current
      if (resolveSessionDismissal(current, sessionId, decisions) === current) return false
      const keys = current.tabOrderBySession[sessionId] ?? []
      dispatch({ type: 'dismiss-resolve', sessionId, decisions })
      cleanupSessionRequests(keys)
      dismissSession(sessionId)
      return true
    })()

    dismissalInFlight.current.set(sessionId, dismissal)
    void dismissal.finally(() => dismissalInFlight.current.delete(sessionId))
    return dismissal
  }

  const api: DocumentWorkspaceApi = {
    state,
    openDocument: (input) => dispatch({ type: 'open', input, token: ++loadTokenRef.current }),
    selectDocument: (sessionId, key) => dispatch({ type: 'activate', sessionId, key }),
    updateDocumentDraft: (key, draft) => dispatch({ type: 'draft', key, draft }),
    resolveCloseDocument: (choice) => dispatch({ type: 'close-resolve', choice }),
    saveDocument,
    requestCloseDocument: (key) => dispatch({ type: 'close-request', key }),
    requestSessionDismissal
  }

  return (
    <DocumentWorkspaceContext.Provider value={api}>
      {children}
      {dismissalPrompt && (
        <div ref={dismissalDialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="dismiss-session-title" aria-describedby="dismiss-session-description" onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!dismissalSaving) answerDismissalPrompt('cancel') } else trapModalFocus(event) }} className="modal-scrim fixed inset-0 z-[60] flex items-center justify-center">
          <div className="glass-modal w-96 p-4">
            <p id="dismiss-session-title" className="text-sm text-text-hi">Save changes before dismissing this session?</p>
            <p className="mt-2 font-mono text-[11px] text-text-mid">{basename(dismissalPrompt.filePath)}</p>
            <p id="dismiss-session-description" className="mt-1 break-all font-mono text-[10px] text-text-hint">{dismissalPrompt.filePath}</p>
            <p className="mt-3 text-xs text-amber-400">Unsaved changes</p>
            <div className="mt-4 flex justify-end gap-2">
              <button ref={dismissalCancelRef} className="btn-ghost" disabled={dismissalSaving} onClick={() => answerDismissalPrompt('cancel')}>Cancel</button>
              <button className="btn-outline" disabled={dismissalSaving} onClick={() => answerDismissalPrompt('discard')}>Discard</button>
              <button className="btn-primary" disabled={dismissalSaving} onClick={() => answerDismissalPrompt('save')}>Save</button>
            </div>
          </div>
        </div>
      )}
    </DocumentWorkspaceContext.Provider>
  )
}

export function DocumentWorkspace(): JSX.Element | null {
  const selectedSessionId = useStore((s) => s.selectedSessionId)
  const {
    state,
    selectDocument,
    updateDocumentDraft,
    saveDocument,
    requestCloseDocument,
    resolveCloseDocument
  } = useDocumentWorkspace()
  const keys = selectedSessionId ? state.tabOrderBySession[selectedSessionId] ?? [] : []
  const activeKey = selectedSessionId ? state.activeKeyBySession[selectedSessionId] : null
  const activeDocument = activeKey ? state.documents.get(activeKey) ?? null : null
  const closeDialogRef = useRef<HTMLDivElement>(null)
  const pending = state.pendingCloseKey ? state.documents.get(state.pendingCloseKey) ?? null : null
  const closeCancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((!event.ctrlKey && !event.metaKey) || event.key.toLowerCase() !== 'w') return
      if (!activeDocument || pending || document.querySelector('[role="dialog"]')) return
      event.preventDefault()
      requestCloseDocument(activeDocument.key)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activeDocument, pending, requestCloseDocument])

  useEffect(() => {
    if (!pending) return
    if (pending.saving) closeDialogRef.current?.focus()
    else closeCancelRef.current?.focus()
  }, [pending, pending?.saving])
  const resolvePending = async (choice: 'save-success' | 'discard' | 'cancel'): Promise<void> => {
    if (choice === 'save-success' && pending && !(await saveDocument(pending.key))) return
    resolveCloseDocument(choice)
  }

  if (!selectedSessionId) return null
  // With no open files (and no close dialog) there is nothing to show. Returning
  // an element here would still claim `flex-1` and eat half the session view as an
  // empty band beneath the terminal — the "dead space". Take zero height instead.
  if (keys.length === 0 && !pending) return null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {keys.length > 0 && (
        <nav aria-label="Open files" role="tablist" className="glass-bar flex shrink-0 overflow-x-auto border-b">
          {keys.map((key) => {
            const document = state.documents.get(key)!
            const dirty = document.draft !== document.original
            return <button key={key} id={`document-tab-${key}`} role="tab" aria-controls={`document-panel-${key}`} aria-selected={key === activeKey} tabIndex={key === activeKey ? 0 : -1} onClick={() => selectDocument(selectedSessionId, key)} className={`glass-divider flex items-center gap-1.5 border-r px-3 py-2 font-mono text-[11px] ${key === activeKey ? 'bg-accent/10 text-text-hi' : 'text-text-low hover:bg-[var(--glass-hover)]'}`}>
              {basename(document.filePath)}
              {dirty && <Circle size={7} className="fill-amber-400 text-amber-400" />}
              <span className="sr-only">{dirty ? 'unsaved' : 'saved'}</span>
            </button>
          })}
        </nav>
      )}
      {activeDocument && <div id={`document-panel-${activeDocument.key}`} role="tabpanel" aria-labelledby={`document-tab-${activeDocument.key}`} className="min-h-0 flex-1"><CodeEditor document={activeDocument} onDraftChange={(draft) => updateDocumentDraft(activeDocument.key, draft)} onSave={() => saveDocument(activeDocument.key).then(() => undefined)} onRequestClose={() => requestCloseDocument(activeDocument.key)} /></div>}
      {pending && (
        <div ref={closeDialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="close-document-title" aria-describedby="close-document-description" onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!pending.saving) void resolvePending('cancel') } else trapModalFocus(event) }} className="modal-scrim absolute inset-0 z-50 flex items-center justify-center">
          <div className="glass-modal w-80 p-4">
            <p id="close-document-title" className="text-sm text-text-hi">Save changes to {basename(pending.filePath)}?</p>
            <p id="close-document-description" className="mt-2 text-xs text-text-mid">Your draft is unsaved.</p>
            <div className="mt-4 flex justify-end gap-2">
              <button ref={closeCancelRef} className="btn-ghost" disabled={pending.saving} onClick={() => void resolvePending('cancel')}>Cancel</button>
              <button className="btn-outline" disabled={pending.saving} onClick={() => void resolvePending('discard')}>Discard</button>
              <button className="btn-primary" disabled={pending.saving} onClick={() => void resolvePending('save-success')}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
