// Connect dialog: the operator's way to point this device at a Conductor core
// (desktop same-origin, a dev core, or a PC core over the LAN from the Android
// APK) and supply its access token. Shown automatically when the opening
// handshake fails (incl. a 401 from a missing/wrong token), and re-openable any
// time from the TopBar connection chip. Saving validates + normalizes the Core
// URL, persists to localStorage, and reloads so every URL re-resolves atomically.
// "Forget" clears the saved pairing so a device can be un-paired.

import { useMemo, useState } from 'react'
import { Lock } from 'lucide-react'
import { useCore } from '../state/coreContext'
import {
  forgetConnection,
  hasStoredConnection,
  resolveConnection,
  saveConnection
} from '../state/connection'
import { normalizeCoreUrl } from '../state/urlValidation'
import { Button, Field, Notice, TextArea, TextInput } from './ui'
import { decodePairing } from '../state/pairing'
import { PairingScanner, canScanPairing } from './PairingScanner'

export function ConnectScreen(): JSX.Element | null {
  const { connectOpen, closeConnect, bootError } = useCore()
  // Defaults come from the currently-resolved connection (localStorage → query
  // → origin), captured once on mount; the component stays mounted while closed
  // so the operator's in-progress edits survive an accidental open/close.
  const initial = useMemo(() => resolveConnection(), [])
  const [base, setBase] = useState(initial.apiBase)
  const [token, setToken] = useState(initial.apiToken)
  const [pairCode, setPairCode] = useState('')
  const [pairError, setPairError] = useState<string | null>(null)
  const [urlError, setUrlError] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  // Whether a pairing is currently persisted (so the Forget control shows).
  const paired = useMemo(() => hasStoredConnection(), [])

  const applyCode = (code: string): void => {
    const target = decodePairing(code)
    if (!target) {
      setPairError('That is not a valid pairing code — paste the full C1:… code (the C1: prefix is optional).')
      return
    }
    // Normalize the decoded URL too, so a paired base is never saved with a
    // trailing slash or a non-http scheme.
    const norm = normalizeCoreUrl(target.u)
    if (!norm.ok) {
      setPairError(norm.error)
      return
    }
    saveConnection(norm.url, target.t, target.fingerprint)
  }

  const onConnect = (): void => {
    const norm = normalizeCoreUrl(base)
    if (!norm.ok) {
      setUrlError(norm.error)
      return
    }
    setUrlError(null)
    saveConnection(norm.url, token)
  }

  // A boot error pins the dialog open: there is no connected core to fall back
  // to, so Cancel is hidden and the backdrop click is inert until a save+reload
  // resolves the connection.
  const pinned = !!bootError
  if (!connectOpen) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={pinned ? undefined : closeConnect}
    >
      <div
        className="w-full max-w-md rounded-lg border border-edge bg-bg-1 p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-sm font-semibold text-text-hi">Connect to Conductor core</h2>
        <p className="mt-1 text-xs text-text-hint">
          Point this device at the core (e.g. on your PC over the LAN) and supply its access token.
        </p>
        {initial.apiFingerprint ? (
          <div
            className="mt-3 flex items-center gap-1.5 rounded-md border border-edge bg-bg-2 px-3 py-2 font-mono text-[11px] text-text-mid"
            title={`SHA-256 cert fingerprint: ${initial.apiFingerprint}`}
          >
            <Lock size={12} className="shrink-0 text-accent-green" />
            <span className="shrink-0">TLS · pinned cert</span>
            <span className="text-text-hint">
              {initial.apiFingerprint.split(':').slice(0, 4).join(':')}…
            </span>
          </div>
        ) : null}

        {pinned ? (
          <div className="mt-3">
            <Notice tone="error">{bootError}</Notice>
          </div>
        ) : null}

        <div className="mt-4 flex flex-col gap-3">
          <div>
            <Field label="Core URL" hint="e.g. http://192.168.1.50:47615">
              <TextInput
                value={base}
                onChange={(e) => {
                  setBase(e.target.value)
                  if (urlError) setUrlError(null)
                }}
                placeholder="http://192.168.1.50:47615"
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                inputMode="url"
              />
            </Field>
            {urlError ? (
              <p className="mt-1 text-xs text-[rgb(var(--danger))]">{urlError}</p>
            ) : null}
          </div>
          <Field label="Access token" hint="Leave blank if the core has no token set.">
            <TextInput
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="(no token)"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </Field>
        </div>

        <div className="mt-4 border-t border-edge pt-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-text-mid">Or pair with a code</span>
            {canScanPairing() && !scanning ? (
              <Button
                variant="ghost"
                onClick={() => {
                  setPairError(null)
                  setScanning(true)
                }}
              >
                Scan QR
              </Button>
            ) : null}
          </div>
          {scanning ? (
            <PairingScanner
              onCode={(c) => {
                setScanning(false)
                applyCode(c)
              }}
              onClose={() => setScanning(false)}
            />
          ) : (
            <div className="mt-2 flex flex-col gap-2">
              <TextArea
                value={pairCode}
                onChange={(e) => setPairCode(e.target.value)}
                placeholder="Paste a C1:… code from the desktop Remote access panel"
                rows={2}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
              <div className="flex justify-end">
                <Button variant="ghost" onClick={() => applyCode(pairCode)} disabled={!pairCode.trim()}>
                  Use code
                </Button>
              </div>
            </div>
          )}
          {pairError ? (
            <div className="mt-2">
              <Notice tone="error">{pairError}</Notice>
            </div>
          ) : null}
        </div>

        <div className="mt-5 flex items-center justify-between gap-2">
          {paired ? (
            <Button variant="danger" onClick={() => forgetConnection()}>
              Forget
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            {pinned ? null : (
              <Button variant="ghost" onClick={closeConnect}>
                Cancel
              </Button>
            )}
            <Button variant="primary" onClick={onConnect} disabled={!base.trim()}>
              Connect
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
