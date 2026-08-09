import { describe, expect, it } from 'vitest'
import { decodePairing } from './pairing'

/** Build a `C1:` code the way the desktop core does (base64url of the JSON). */
function encode(payload: unknown): string {
  return `C1:${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`
}

describe('decodePairing', () => {
  it('decodes a valid code into url + token', () => {
    const code = encode({ u: 'http://192.168.1.50:47616', t: 'sekret' })
    expect(decodePairing(code)).toEqual({ u: 'http://192.168.1.50:47616', t: 'sekret' })
  })

  it('defaults the token to empty when absent or non-string', () => {
    expect(decodePairing(encode({ u: 'http://x:1' }))).toEqual({ u: 'http://x:1', t: '' })
    expect(decodePairing(encode({ u: 'http://x:1', t: 42 }))).toEqual({ u: 'http://x:1', t: '' })
  })

  it('trims surrounding whitespace before decoding', () => {
    const code = encode({ u: 'http://x:1', t: 'k' })
    expect(decodePairing(`  \n${code}\n `)).toEqual({ u: 'http://x:1', t: 'k' })
  })

  it('decodes a bare payload pasted without the C1: prefix', () => {
    const bare = Buffer.from(JSON.stringify({ u: 'http://10.0.0.5:8787', t: 'tok' }), 'utf8').toString('base64url')
    expect(decodePairing(bare)).toEqual({ u: 'http://10.0.0.5:8787', t: 'tok' })
    // A bare payload with surrounding whitespace still decodes.
    expect(decodePairing(`\n${bare}\t`)).toEqual({ u: 'http://10.0.0.5:8787', t: 'tok' })
  })

  it('returns null for the wrong version prefix', () => {
    expect(decodePairing('C2:whatever')).toBeNull()
    expect(decodePairing('http://x:1')).toBeNull()
    expect(decodePairing('')).toBeNull()
  })

  it('returns null for malformed base64 or JSON', () => {
    expect(decodePairing('C1:not-valid-base64!!!')).toBeNull()
    expect(decodePairing(`C1:${Buffer.from('not json', 'utf8').toString('base64url')}`)).toBeNull()
  })

  it('never throws — any garbage yields null, not an exception', () => {
    const cases = ['', '   ', 'garbage', 'C1:', 'C1:!!!', 'C2:whatever', 'http://x:1', '{ has spaces }']
    for (const c of cases) expect(() => decodePairing(c)).not.toThrow()
    for (const c of cases) expect(decodePairing(c)).toBeNull()
  })

  it('returns null when the payload lacks a string url', () => {
    expect(decodePairing(encode({ t: 'k' }))).toBeNull()
    expect(decodePairing(encode({ u: 123, t: 'k' }))).toBeNull()
    expect(decodePairing(encode(['not', 'an', 'object']))).toBeNull()
  })

  it('decodes a TLS code carrying a cert fingerprint (f)', () => {
    const code = encode({ u: 'https://192.168.1.50:47616', t: 'sekret', f: 'AB:CD:EF:01:23:45' })
    expect(decodePairing(code)).toEqual({
      u: 'https://192.168.1.50:47616',
      t: 'sekret',
      fingerprint: 'AB:CD:EF:01:23:45'
    })
  })

  it('omits the fingerprint when f is absent (plaintext code, today shape)', () => {
    const target = decodePairing(encode({ u: 'http://x:1', t: 'k' }))
    expect(target).toEqual({ u: 'http://x:1', t: 'k' })
    expect(target?.fingerprint).toBeUndefined()
  })

  it('ignores a non-string f (treated as absent)', () => {
    expect(decodePairing(encode({ u: 'http://x:1', t: 'k', f: 42 }))).toEqual({ u: 'http://x:1', t: 'k' })
  })

  it('keeps whitespace + prefix tolerance for a TLS code', () => {
    const bare = Buffer.from(
      JSON.stringify({ u: 'https://10.0.0.5:8787', t: 'tok', f: 'AB:CD:EF' }),
      'utf8'
    ).toString('base64url')
    expect(decodePairing(`\n  ${bare}  `)).toEqual({
      u: 'https://10.0.0.5:8787',
      t: 'tok',
      fingerprint: 'AB:CD:EF'
    })
  })
})
