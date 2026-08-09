// Settings → Remote access: shows the pairing QR + URL + token + code so the
// operator can connect the phone app (the Capacitor web client) to this core
// over the LAN. The values come from the main process via
// `window.api.getPairingInfo()`, which reflects the running web server's bound
// LAN address, token, and a scannable `C1:` pairing code.

import { useCallback, useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { Check, Copy, RefreshCw } from 'lucide-react'

interface PairingInfo {
  url: string | null
  token: string | null
  code: string | null
}

export function RemoteAccessSection(): JSX.Element {
  const [info, setInfo] = useState<PairingInfo | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  const load = useCallback(async () => {
    const next = await window.api.getPairingInfo()
    setInfo(next)
    if (next.code) {
      try {
        setQr(await QRCode.toDataURL(next.code, { margin: 1, width: 220 }))
      } catch {
        setQr(null)
      }
    } else {
      setQr(null)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const copy = (label: string, value: string): void => {
    void navigator.clipboard.writeText(value)
    setCopied(label)
    window.setTimeout(() => setCopied(null), 1200)
  }

  const listening = !!info?.url
  const loopbackOnly = !info?.url || info.url.startsWith('http://127.') || !info.token

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-text-low">
          Scan this from the Conductor phone app (or paste the code) to drive this core over your LAN.
        </p>
        <button className="btn-ghost" onClick={() => void load()} title="Refresh">
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {!listening ? (
        <p className="font-mono text-[11px] text-text-hint">
          The remote web server is not listening yet.
        </p>
      ) : (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
          {qr ? (
            <img
              src={qr}
              alt="Pairing QR code"
              className="h-[180px] w-[180px] shrink-0 rounded-md border border-edge bg-white p-2"
            />
          ) : null}
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <PairRow label="Core URL" value={info?.url ?? ''} copied={copied === 'url'} onCopy={() => copy('url', info?.url ?? '')} />
            <PairRow
              label="Access token"
              value={info?.token ?? '(none — loopback)'}
              copied={copied === 'token'}
              onCopy={() => info?.token && copy('token', info.token)}
            />
            <PairRow label="Pairing code" value={info?.code ?? ''} copied={copied === 'code'} onCopy={() => info?.code && copy('code', info.code)} mono />
          </div>
        </div>
      )}

      {loopbackOnly ? (
        <p className="font-mono text-[10px] text-text-hint">
          Bound to loopback. To expose over your LAN, start Conductor with CONDUCTOR_WEB_HOST=0.0.0.0
          (an access token is generated automatically), then refresh.
        </p>
      ) : null}
    </div>
  )
}

function PairRow({
  label,
  value,
  copied,
  onCopy,
  mono
}: {
  label: string
  value: string
  copied: boolean
  onCopy: () => void
  mono?: boolean
}): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <span className="w-24 shrink-0 text-xs text-text-low">{label}</span>
      <code className={`min-w-0 flex-1 truncate rounded bg-bg-2 px-2 py-1 text-[11px] ${mono ? 'font-mono' : ''}`}>
        {value}
      </code>
      <button className="btn-ghost" onClick={onCopy} title={`Copy ${label}`}>
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
    </div>
  )
}
