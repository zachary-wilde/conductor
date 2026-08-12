import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { createReplayGate } from '../lib/terminalReplay'

type TerminalPalette = {
  background: string
  foreground: string
  cursor: string
  cursorAccent: string
  selectionBackground: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

const FLAT_FALLBACKS = {
  bg0: '#0a0a0b',
  bg1: '#111113',
  textHi: '#f5f5f7',
  textMid: '#a1a1aa',
  textLow: '#6b6b76',
  accent: '#8b7cf6',
  success: '#3ddc97',
  red: '#ef4444',
  blue: '#2563eb',
  purple: '#a855f7',
  cyan: '#32d4de'
}

function cssTokenHex(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback

  const channels = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim()
    .split(/\s+/)
    .map(Number)

  if (channels.length !== 3 || channels.some((channel) => !Number.isFinite(channel))) {
    return fallback
  }

  return `#${channels
    .map((channel) => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, '0'))
    .join('')}`
}

export const terminalTheme = (plainShell: boolean): TerminalPalette => {
  const bg0 = cssTokenHex('--bg-0', FLAT_FALLBACKS.bg0)
  const bg1 = cssTokenHex('--bg-1', FLAT_FALLBACKS.bg1)
  const textHi = cssTokenHex('--text-hi', FLAT_FALLBACKS.textHi)
  const textMid = cssTokenHex('--text-mid', FLAT_FALLBACKS.textMid)
  const textLow = cssTokenHex('--text-low', FLAT_FALLBACKS.textLow)
  const accent = cssTokenHex('--accent', FLAT_FALLBACKS.accent)
  const success = cssTokenHex('--success', FLAT_FALLBACKS.success)
  const red = cssTokenHex('--accent-red', FLAT_FALLBACKS.red)
  const yellow = cssTokenHex('--accent-yellow', accent)
  const blue = cssTokenHex('--accent-blue', FLAT_FALLBACKS.blue)
  const purple = cssTokenHex('--accent-purple', FLAT_FALLBACKS.purple)
  const cyan = cssTokenHex('--accent-cyan', FLAT_FALLBACKS.cyan)

  return {
    background: 'transparent',
    foreground: plainShell ? success : textHi,
    cursor: accent,
    cursorAccent: bg1,
    selectionBackground: `${accent}52`,
    black: bg0,
    red,
    green: success,
    yellow,
    blue,
    magenta: purple,
    cyan,
    white: textMid,
    brightBlack: textLow,
    brightRed: red,
    brightGreen: success,
    brightYellow: yellow,
    brightBlue: blue,
    brightMagenta: purple,
    brightCyan: cyan,
    brightWhite: textHi
  }
}
export function TerminalView({
  sessionId,
  plainShell = false
}: {
  sessionId: string
  plainShell?: boolean
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, 'Courier New', monospace",
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'bar',
      allowProposedApi: true,
      allowTransparency: true,
      theme: terminalTheme(plainShell),
      scrollback: 5000
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(host)
    termRef.current = term

    // Initial fit (host may not have size yet — rAF helps).
    requestAnimationFrame(() => {
      try {
        fit.fit()
      } catch {
        /* host not sized yet */
      }
      const dims = { cols: term.cols, rows: term.rows }
      window.api.resizeSession(sessionId, dims.cols, dims.rows)
    })

    // Input -> pty.
    const dispInput = term.onData((data) => window.api.writeToSession(sessionId, data))

    // Output -> terminal. Live chunks route through a replay gate so a
    // reconnecting terminal hydrates the Core snapshot before live output,
    // closing the disconnect gap. Subscribe BEFORE the async snapshot so
    // chunks in flight queue and flush in order after the snapshot. Each live
    // chunk carries the Core's monotonic generation so the gate can drop
    // chunks already covered by the snapshot (no duplicate output).
    let disposed = false
    const gate = createReplayGate((chunk) => term.write(chunk))
    const unsubData = window.api.onPtyData((id, data, generation) => {
      if (id === sessionId) gate.pushLive(data, generation)
    })

    window.api
      .snapshotSession(sessionId)
      .then((snap) => {
        if (disposed) return
        for (const chunk of gate.completeSnapshot(snap?.buffer ?? '', snap?.generation ?? 0)) {
          if (disposed) return
          if (chunk) term.write(chunk)
        }
      })
      .catch(() => {
        if (disposed) return
        for (const chunk of gate.completeSnapshot('', 0)) {
          if (disposed) return
          if (chunk) term.write(chunk)
        }
      })

    const unsubExit = window.api.onPtyExit((id) => {
      if (id === sessionId) {
        term.write('\r\n\x1b[2m— session ended —\x1b[0m\r\n')
      }
    })

    // Resize observer -> refit + notify pty.
    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
        window.api.resizeSession(sessionId, term.cols, term.rows)
      } catch {
        /* ignore during teardown */
      }
    })
    ro.observe(host)

    term.focus()

    return () => {
      disposed = true
      dispInput.dispose()
      unsubData()
      unsubExit()
      ro.disconnect()
      term.dispose()
      termRef.current = null
    }
  }, [plainShell, sessionId])

  return <div ref={hostRef} className="terminal-surface h-full w-full overflow-hidden p-2" />
}
