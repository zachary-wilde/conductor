import { lazy, Suspense } from 'react'
import { useStore } from '../store/useStore'
import { basename } from '../lib/path'
import type { DocumentRecord } from '../lib/documentWorkspace'
import { X, Save, Loader2, Circle } from 'lucide-react'

// Monaco is intentionally lazy: the dashboard must not load editor code until a file opens.
const LazyMonacoEditor = lazy(async () => ({ default: (await import('./LazyMonacoEditor')).LazyMonacoEditor }))

export interface CodeEditorProps {
  document: DocumentRecord
  onDraftChange: (value: string) => void
  onSave: () => Promise<void>
  onRequestClose: () => void
}

export function CodeEditor({ document, onDraftChange, onSave, onRequestClose }: CodeEditorProps): JSX.Element {
  const editorSettings = useStore((s) => s.settings.editor)
  const dirty = document.draft !== document.original

  return <div className="dense-surface flex h-full min-h-0 flex-col">
    <div className="glass-bar flex items-center gap-2 border-b px-3 py-1.5">
      <span className="max-w-[40%] truncate font-mono text-[11px] text-text-mid" title={document.filePath}>{basename(document.filePath)}</span>
      {dirty && <Circle size={9} className="shrink-0 fill-amber-400 text-amber-400" />}
      <div className="flex-1" />
      {document.saveError && <span className="font-mono text-[10px] text-red-400">{document.saveError}</span>}
      <button className="rounded p-1 text-text-low hover:bg-[var(--glass-hover)] hover:text-text-hi disabled:opacity-40" onClick={() => void onSave()} disabled={!dirty || document.saving} title="Save (Ctrl+S)">{document.saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}</button>
      <button className="rounded p-1 text-text-low hover:bg-[var(--glass-hover)] hover:text-text-hi" onClick={onRequestClose} title="Close"><X size={13} /></button>
    </div>
    <div className="min-h-0 flex-1">
      {document.phase === 'loading' ? <div className="flex h-full items-center justify-center text-text-hint"><Loader2 size={16} className="animate-spin" /></div> : document.phase === 'read-error' ? <div className="p-4 font-mono text-[11px] text-red-400">Could not read this file (binary, unreadable, or missing).</div> : <Suspense fallback={<div className="flex h-full items-center justify-center text-text-hint"><Loader2 size={16} className="animate-spin" /></div>}><LazyMonacoEditor document={document} onDraftChange={onDraftChange} onSave={onSave} settings={editorSettings} /></Suspense>}
    </div>
  </div>
}
