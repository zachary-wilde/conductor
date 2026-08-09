import { describe, expect, it } from 'vitest'
import { normalizeCoreUrl } from './urlValidation'

describe('normalizeCoreUrl', () => {
  it('accepts a clean http URL', () => {
    expect(normalizeCoreUrl('http://192.168.1.50:47615')).toEqual({
      ok: true,
      url: 'http://192.168.1.50:47615'
    })
  })

  it('accepts an https URL', () => {
    expect(normalizeCoreUrl('https://core.example.com')).toEqual({
      ok: true,
      url: 'https://core.example.com'
    })
  })

  it('strips a trailing slash', () => {
    const r = normalizeCoreUrl('http://192.168.1.50:47615/')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.url).toBe('http://192.168.1.50:47615')
  })

  it('strips multiple trailing slashes', () => {
    const r = normalizeCoreUrl('http://core:1///')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.url).toBe('http://core:1')
  })

  it('trims surrounding whitespace before validating', () => {
    const r = normalizeCoreUrl('  http://core:1/  ')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.url).toBe('http://core:1')
  })

  it('rejects an empty / whitespace-only value', () => {
    expect(normalizeCoreUrl('')).toMatchObject({ ok: false })
    expect(normalizeCoreUrl('   ').ok).toBe(false)
  })

  it('rejects a scheme-less host:port', () => {
    const r = normalizeCoreUrl('192.168.1.50:47615')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/http/i)
  })

  it('rejects a non-http(s) scheme', () => {
    const r = normalizeCoreUrl('ftp://core:1')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/http/i)
  })

  it('rejects a scheme that is just a bare word (e.g. localhost:port)', () => {
    expect(normalizeCoreUrl('localhost:47615').ok).toBe(false)
  })

  it('preserves a non-root path while stripping its trailing slash', () => {
    const r = normalizeCoreUrl('http://core:1/proxy/')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.url).toBe('http://core:1/proxy')
  })
})
