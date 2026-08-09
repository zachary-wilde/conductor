import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { X509Certificate } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { loadOrCreateTls } from './tls'

describe('core TLS material', () => {
  it('generates, persists, and reuses a stable self-signed cert', () => {
    const dir = mkdtempSync(join(tmpdir(), 'core-tls-'))

    const a = loadOrCreateTls(dir)
    expect(a.key).toContain('PRIVATE KEY')
    expect(a.cert).toContain('BEGIN CERTIFICATE')
    // SHA-256 fingerprint: 32 colon-separated uppercase hex byte pairs.
    expect(a.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
    expect(a.fingerprint).toBe(new X509Certificate(a.cert).fingerprint256)
    expect(existsSync(join(dir, 'tls', 'cert.pem'))).toBe(true)
    expect(existsSync(join(dir, 'tls', 'key.pem'))).toBe(true)

    // A stable pin: reloading returns the SAME cert, not a fresh one.
    const b = loadOrCreateTls(dir)
    expect(b.cert).toBe(a.cert)
    expect(b.fingerprint).toBe(a.fingerprint)
  })
})
