import { useCallback, useEffect, useState } from 'react'
import { ChevronRight, File, Folder, CornerLeftUp, Loader2 } from 'lucide-react'
import { basename, dirname } from '../lib/path'

interface Entry {
  name: string
  path: string
  isDir: boolean
}

const MAX_BYTES = 600_000

export interface FileViewerProps {
  root: string
  /** When provided, file clicks delegate upward (editor lives in the parent). */
  onOpenFile?: (path: string) => void
  /** Path currently open in the parent editor, for highlight. */
  selectedPath?: string | null
}

export function FileViewer({ root, onOpenFile, selectedPath }: FileViewerProps): JSX.Element {
  const [cwd, setCwd] = useState(root)
  const [entries, setEntries] = useState<Entry[]>([])
  const [file, setFile] = useState<{ path: string; content: string } | null>(null)
  const [loading, setLoading] = useState(false)

  // Follow the caller's root when it changes (e.g. switching to a
  // different session's worktree) — cwd must never survive a root swap.
  useEffect(() => {
    setCwd(root)
    setFile(null)
  }, [root])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    window.api.listDir(cwd).then((e) => {
      if (cancelled) return
      setEntries(e)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [cwd])

  const openFile = useCallback(
    async (path: string) => {
      if (onOpenFile) {
        onOpenFile(path)
        return
      }
      const content = await window.api.readFile(path)
      setFile({ path, content: content ?? '' })
    },
    [onOpenFile]
  )

  const rel = cwd.replace(root, '').replace(/^[\\/]/, '')
  const crumbs = rel ? rel.split(/[\\/]/).filter(Boolean) : []
  const activePath = selectedPath ?? file?.path
  const showViewer = file && !onOpenFile

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Breadcrumb */}
      <div className="glass-divider flex items-center gap-1 border-b px-3 py-2 font-mono text-[11px] text-text-low">
        <button className="hover:text-text-hi" onClick={() => setCwd(root)}>
          {basename(root)}
        </button>
        {crumbs.map((c, i) => (
          <span key={i} className="flex items-center gap-1">
            <ChevronRight size={11} className="text-text-hint" />
            <button
              className="hover:text-text-hi"
              onClick={() => setCwd(root + '/' + crumbs.slice(0, i + 1).join('/'))}
            >
              {c}
            </button>
          </span>
        ))}
      </div>

      {/* Listing */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && (
          <div className="flex items-center gap-2 px-3 py-3 text-xs text-text-hint">
            <Loader2 size={13} className="animate-spin" /> reading…
          </div>
        )}
        {!loading && cwd !== root && (
          <button
            className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-text-low hover:bg-[var(--glass-hover)] hover:text-text-mid"
            onClick={() => setCwd(dirname(cwd) === dirname(root) && cwd === root ? root : dirname(cwd))}
          >
            <CornerLeftUp size={13} /> ..
          </button>
        )}
        {!loading &&
          entries.map((e) => (
            <button
              key={e.path}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--glass-hover)] ${
                activePath === e.path ? 'bg-accent/10 text-accent' : 'text-text-mid'
              }`}
              onClick={() => (e.isDir ? setCwd(e.path) : openFile(e.path))}
            >
              {e.isDir ? (
                <Folder size={13} className="text-text-low" />
              ) : (
                <File size={13} className="text-text-hint" />
              )}
              <span className="truncate">{e.name}</span>
            </button>
          ))}
        {!loading && entries.length === 0 && cwd === root && (
          <div className="px-3 py-3 text-xs text-text-hint">Empty directory.</div>
        )}
      </div>

      {/* Read-only viewer (only in standalone mode; delegated mode renders the editor in the parent) */}
      {showViewer && file && (
        <div className="glass-divider flex h-[45%] min-h-0 flex-col border-t">
          <div className="glass-divider flex items-center justify-between border-b px-3 py-1.5">
            <span className="truncate font-mono text-[11px] text-text-mid">{basename(file.path)}</span>
            <span className="font-mono text-[10px] text-text-hint">
              {file.content.length > MAX_BYTES
                ? `${(file.content.length / 1024).toFixed(0)}KB`
                : `${file.content.split('\n').length} lines`}
            </span>
          </div>
          <div className="dense-surface selectable min-h-0 flex-1 overflow-auto">
            {file.content.length > MAX_BYTES ? (
              <div className="p-3 text-xs text-text-hint">
                File too large to preview ({(file.content.length / 1024).toFixed(0)} KB). Open it externally.
              </div>
            ) : (
              <pre className="px-3 py-2 font-mono text-[12px] leading-[1.55] text-text-mid">
                {file.content || '<empty>'}
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
