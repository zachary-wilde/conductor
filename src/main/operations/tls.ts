// Self-signed TLS material for the Core's remote (LAN) web server.
//
// Non-loopback web binds enable TLS by default; an explicit
// `CONDUCTOR_WEB_TLS=0` is refused for those binds. The Core generates a
// self-signed certificate once and PERSISTS it under the data dir, so the
// certificate fingerprint is STABLE across restarts. A stable fingerprint is
// what makes pinning possible — it goes into the pairing code, and a client
// (the native Capacitor layer, a separate track) pins to it. Regenerating on
// every boot would defeat that.
//
// Plaintext is reserved for loopback unless an upstream policy changes.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { X509Certificate } from 'node:crypto'
import selfsigned from 'selfsigned'

export interface CoreTls {
  /** PEM private key. */
  key: string
  /** PEM certificate. */
  cert: string
  /** SHA-256 fingerprint of the certificate (colon-separated hex, e.g. `AB:CD:…`). */
  fingerprint: string
}

/**
 * Load the Core's self-signed TLS material from `dir/tls`, generating and
 * persisting it on first use. The returned {@link CoreTls.fingerprint} is stable
 * for the life of the on-disk cert, so it can be pinned via the pairing code.
 */
export function loadOrCreateTls(dir: string): CoreTls {
  const tlsDir = join(dir, 'tls')
  const keyPath = join(tlsDir, 'key.pem')
  const certPath = join(tlsDir, 'cert.pem')

  let key: string
  let cert: string
  if (existsSync(keyPath) && existsSync(certPath)) {
    key = readFileSync(keyPath, 'utf8')
    cert = readFileSync(certPath, 'utf8')
  } else {
    mkdirSync(tlsDir, { recursive: true })
    const pems = selfsigned.generate([{ name: 'commonName', value: 'Conductor Core' }], {
      keySize: 2048,
      days: 3650,
      algorithm: 'sha256'
    })
    key = pems.private
    cert = pems.cert
    writeFileSync(keyPath, key, 'utf8')
    writeFileSync(certPath, cert, 'utf8')
  }

  return { key, cert, fingerprint: new X509Certificate(cert).fingerprint256 }
}
