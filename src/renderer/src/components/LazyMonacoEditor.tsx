import { useRef } from 'react'
import Editor, { loader, type BeforeMount, type OnMount, type Monaco } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import type { editor } from 'monaco-editor'
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import jsonWorker from 'monaco-editor/language/json/json.worker.js?worker'
import cssWorker from 'monaco-editor/language/css/css.worker.js?worker'
import htmlWorker from 'monaco-editor/language/html/html.worker.js?worker'
import tsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker'
import type { DocumentRecord } from '../lib/documentWorkspace'

self.MonacoEnvironment = {
  getWorker(_workerId, label) {
    if (label === 'json') return new jsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker()
    if (label === 'typescript' || label === 'javascript') return new tsWorker()
    return new editorWorker()
  }
}
loader.config({ monaco })

// Extension -> Monaco language id.
const LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json',
  css: 'css', scss: 'scss', less: 'less',
  html: 'html', htm: 'html', vue: 'html', svelte: 'html',
  md: 'markdown', markdown: 'markdown',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
  java: 'java', kt: 'kotlin', swift: 'swift',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  cs: 'csharp', php: 'php', pl: 'perl', pm: 'perl',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
  ps1: 'powershell', psm1: 'powershell',
  yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini',
  xml: 'xml', svg: 'xml', sql: 'sql', lua: 'lua',
  dart: 'dart', scala: 'scala', clj: 'clojure', cljs: 'clojure',
  ex: 'elixir', exs: 'elixir', erl: 'erlang', hs: 'haskell', jl: 'julia',
  r: 'r', graphql: 'graphql', gql: 'graphql', proto: 'proto'
}

const FILENAME_LANG: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  justfile: 'ini',
  '.gitignore': 'ini',
  '.env': 'ini',
  '.editorconfig': 'ini'
}

function languageForPath(path: string): string {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  if (FILENAME_LANG[name]) return FILENAME_LANG[name]
  const ext = name.includes('.') ? (name.split('.').pop() ?? '') : ''
  return LANG_BY_EXT[ext] ?? 'plaintext'
}

// Ctrl+Click same-file go-to-definition.
function wireGotoDefinition(ed: editor.IStandaloneCodeEditor, monacoApi: Monaco): void {
  const patternsFor = (word: string): RegExp[] => {
    const e = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return [
      new RegExp('\\b(?:function|async\\s+function)\\s+' + e + '\\b'),
      new RegExp('\\b(?:export\\s+)?(?:const|let|var)\\s+' + e + '\\b'),
      new RegExp('\\b(?:export\\s+)?(?:class|interface|type|enum)\\s+' + e + '\\b'),
      new RegExp('\\bdef\\s+' + e + '\\s*\\('),
      new RegExp('\\bclass\\s+' + e + '\\b'),
      new RegExp('\\bfunc\\s+' + e + '\\b'),
      new RegExp('\\bfunc\\s+\\([^)]*\\)\\s+' + e + '\\b'),
      new RegExp('\\btype\\s+' + e + '\\b'),
      new RegExp('\\b(?:class|struct|enum|protocol|actor)\\s+' + e + '\\b'),
      new RegExp('\\bfn\\s+' + e + '\\b'),
      new RegExp('\\b(?:struct|enum|trait|mod)\\s+' + e + '\\b'),
      new RegExp('\\b(?:type|const|static)\\s+' + e + '\\b')
    ]
  }

  const findDef = (
    model: editor.ITextModel,
    word: string,
    fromLine: number
  ): { line: number; col: number } | null => {
    const patterns = patternsFor(word)
    const lineCount = model.getLineCount()
    for (let i = 1; i <= lineCount; i++) {
      if (i === fromLine) continue
      const line = model.getLineContent(i)
      if (/\b(?:import|require)\b/.test(line)) continue
      if (patterns.some((p) => p.test(line))) {
        const col = line.indexOf(word)
        if (col !== -1) return { line: i, col: col + 1 }
      }
    }
    return null
  }

  let decorations: string[] = []
  let hoverTimer: ReturnType<typeof setTimeout> | undefined
  const clearDecos = (): void => {
    if (decorations.length) decorations = ed.deltaDecorations(decorations, [])
  }

  ed.onMouseDown((e) => {
    // Ctrl (Windows/Linux) or Cmd (Mac)
    if (!(e.event.ctrlKey || e.event.metaKey) || !e.target.position) return
    const model = ed.getModel()
    if (!model) return
    const wordInfo = model.getWordAtPosition(e.target.position)
    if (!wordInfo) return
    const def = findDef(model, wordInfo.word, e.target.position.lineNumber)
    if (def) {
      ed.setPosition({ lineNumber: def.line, column: def.col })
      ed.revealLineInCenter(def.line)
      ed.focus()
    }
  })

  ed.onMouseMove((e) => {
    const cmd = e.event.ctrlKey || e.event.metaKey
    if (!cmd || !e.target.position) {
      clearDecos()
      return
    }
    const pos = e.target.position
    clearTimeout(hoverTimer)
    hoverTimer = setTimeout(() => {
      const model = ed.getModel()
      if (!model) return
      const wordInfo = model.getWordAtPosition(pos)
      if (!wordInfo) {
        clearDecos()
        return
      }
      const def = findDef(model, wordInfo.word, pos.lineNumber)
      if (def) {
        decorations = ed.deltaDecorations(decorations, [
          {
            range: new monacoApi.Range(
              pos.lineNumber,
              wordInfo.startColumn,
              pos.lineNumber,
              wordInfo.endColumn
            ),
            options: { inlineClassName: 'goto-definition-link' }
          }
        ])
      } else {
        clearDecos()
      }
    }, 80)
  })

  ed.onMouseLeave(() => {
    clearTimeout(hoverTimer)
    clearDecos()
  })
  ed.onDidBlurEditorWidget(clearDecos)
}

export function LazyMonacoEditor({
  document,
  onDraftChange,
  onSave,
  settings
}: {
  document: DocumentRecord
  onDraftChange: (value: string) => void
  onSave: () => Promise<void>
  settings: {
    minimap: boolean
    wordWrap: boolean
    fontSize: number
    fontFamily: string
    gotoDefinition: boolean
  }
}): JSX.Element {
  const saveRef = useRef<() => void>(() => {})
  saveRef.current = () => void onSave()
  const beforeMount: BeforeMount = (api) => api.editor.defineTheme('conductor-dark', { base: 'vs-dark', inherit: true, rules: [], colors: { 'editor.background': '#1a1a1a', 'editorLineNumber.foreground': '#555555', 'editorLineNumber.activeForeground': '#888888' } })
  const onMount: OnMount = (instance) => {
    monaco.editor.setTheme('conductor-dark')
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current())
    if (settings.gotoDefinition) wireGotoDefinition(instance, monaco)
  }
  return (
    <>
      <style>{`.goto-definition-link{text-decoration:underline;cursor:pointer;color:#4fc1ff!important}`}</style>
      <Editor className="dense-surface" value={document.draft} language={languageForPath(document.filePath)} theme="conductor-dark" beforeMount={beforeMount} onMount={onMount} onChange={(value) => onDraftChange(value ?? '')} options={{ minimap: { enabled: settings.minimap }, wordWrap: settings.wordWrap ? 'on' : 'off', fontSize: settings.fontSize, fontFamily: settings.fontFamily || undefined, fontLigatures: true, scrollBeyondLastLine: false, renderLineHighlight: 'line', padding: { top: 8, bottom: 8 }, overviewRulerLanes: 0, hideCursorInOverviewRuler: true, overviewRulerBorder: false, scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 }, contextmenu: false, automaticLayout: true }} />
    </>
  )
}
