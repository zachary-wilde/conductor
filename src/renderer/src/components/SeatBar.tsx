import { useState } from 'react'
import { CheckCircle2, HelpCircle, Loader2 } from 'lucide-react'
import type { Session } from '@shared/types'

/**
 * The two things a human seat needs that an agent gets for free.
 *
 * An agent asks by dropping `.conductor/request.md` and finishes by exiting.
 * Neither is available to a person working in a shell — you should not have to
 * close your terminal to say you are done — so they are buttons instead, hitting
 * the same file protocol and the same completion path.
 *
 * Shown only on a ravel-child session with no harness: that is a claimed brief.
 */
export function SeatBar({ session }: { session: Session }): JSX.Element | null {
  const [mode, setMode] = useState<'idle' | 'ask' | 'finish'>('idle')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  if (session.kind !== 'ravel-child' || session.harness !== null) return null

  const submit = async (): Promise<void> => {
    const body = text.trim()
    if (body.length === 0 && mode === 'ask') return
    setBusy(true)
    try {
      const ok =
        mode === 'ask'
          ? await window.api.askFromSeat(session.id, body)
          : await window.api.finishSeat(session.id, body)
      setNote(
        ok
          ? mode === 'ask'
            ? 'Asked. The orchestrator answers on its next turn.'
            : 'Reported. The orchestrator picks it up from here.'
          : 'That brief is no longer live.'
      )
      if (ok) {
        setText('')
        setMode('idle')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-testid="seat-bar" className="glass-bar glass-bar--raised shrink-0 border-t px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-hint">
          Your seat · {session.briefId}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            className="btn-outline px-2.5 py-1 text-[11.5px]"
            data-testid="seat-ask"
            aria-pressed={mode === 'ask'}
            onClick={() => {
              setNote(null)
              setMode(mode === 'ask' ? 'idle' : 'ask')
            }}
          >
            <HelpCircle size={12} /> Ask orchestrator
          </button>
          <button
            className="btn-primary px-2.5 py-1 text-[11.5px]"
            data-testid="seat-finish"
            aria-pressed={mode === 'finish'}
            onClick={() => {
              setNote(null)
              setMode(mode === 'finish' ? 'idle' : 'finish')
            }}
          >
            <CheckCircle2 size={12} /> Finish brief
          </button>
        </div>
      </div>

      {mode !== 'idle' && (
        <div className="mt-2 flex items-start gap-2">
          <textarea
            autoFocus
            className="glass-input h-16 flex-1 resize-none font-mono text-[11.5px]"
            data-testid="seat-input"
            placeholder={
              mode === 'ask'
                ? 'What do you need from the orchestrator?'
                : 'What you changed, and anything the next brief must know. Optional.'
            }
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void submit()
              }
            }}
          />
          <button
            className="btn-primary px-3 py-1.5 text-[11.5px]"
            data-testid="seat-submit"
            disabled={busy || (mode === 'ask' && text.trim().length === 0)}
            onClick={() => void submit()}
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : null}
            {mode === 'ask' ? 'Ask' : 'Finish'}
          </button>
        </div>
      )}

      {note !== null && <div className="mt-1.5 text-[11px] text-text-low">{note}</div>}
    </div>
  )
}
