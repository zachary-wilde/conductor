import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { BrowserEnv } from './connection'
import {
  forgetConnection,
  hasStoredConnection,
  resolveApiBase,
  resolveApiToken,
  resolveConnection,
  saveConnection
} from './connection'

/**
 * Build an in-memory `BrowserEnv` (localStorage record + a fake location) so the
 * resolution precedence is exercised without a DOM. Returns the `reload` spy so
 * `saveConnection` can assert it triggered a reconnect.
 */
function env(opts: {
  base?: string
  token?: string
  fingerprint?: string
  search?: string
  origin?: string
} = {}): { env: BrowserEnv; reload: Mock } {
  const store: Record<string, string | undefined> = {}
  if (opts.base !== undefined) store['conductor.apiBase'] = opts.base
  if (opts.token !== undefined) store['conductor.apiToken'] = opts.token
  if (opts.fingerprint !== undefined) store['conductor.apiFingerprint'] = opts.fingerprint
  const reload = vi.fn()
  return {
    env: {
      localStorage: {
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => {
          store[k] = v
        },
        removeItem: (k: string) => {
          store[k] = undefined
        }
      },
      location: {
        search: opts.search ?? '',
        origin: opts.origin ?? 'http://localhost:47615',
        reload
      }
    },
    reload
  }
}

describe('resolveApiBase', () => {
  it('localStorage wins over query and origin', () => {
    const { env: e } = env({
      base: 'http://stored:1/',
      search: '?api=http://query:2',
      origin: 'http://origin:3'
    })
    expect(resolveApiBase(e)).toBe('http://stored:1')
  })

  it('?api= wins over origin when nothing is stored', () => {
    const { env: e } = env({ search: '?api=http://query:2/', origin: 'http://origin:3' })
    expect(resolveApiBase(e)).toBe('http://query:2')
  })

  it('falls back to same-origin when nothing is configured', () => {
    const { env: e } = env({ origin: 'http://origin:3/' })
    expect(resolveApiBase(e)).toBe('http://origin:3')
  })

  it('ignores a whitespace-only stored value and falls through', () => {
    const { env: e } = env({ base: '   ', search: '?api=http://query:9' })
    expect(resolveApiBase(e)).toBe('http://query:9')
  })

  it('ignores a whitespace-only ?api= and falls back to origin', () => {
    const { env: e } = env({ search: '?api=%20%20', origin: 'http://origin:3' })
    expect(resolveApiBase(e)).toBe('http://origin:3')
  })
})

describe('resolveApiToken', () => {
  it('localStorage wins over query', () => {
    const { env: e } = env({ token: 'secret-stored', search: '?token=query-tok' })
    expect(resolveApiToken(e)).toBe('secret-stored')
  })

  it('?token= is used when nothing is stored', () => {
    const { env: e } = env({ search: '?token=query-tok' })
    expect(resolveApiToken(e)).toBe('query-tok')
  })

  it('defaults to empty (unauthenticated core allowed)', () => {
    const { env: e } = env({})
    expect(resolveApiToken(e)).toBe('')
  })
})

describe('resolveConnection', () => {
  it('combines base + token from their respective sources', () => {
    const { env: e } = env({ base: 'http://stored:1', search: '?token=tok' })
    expect(resolveConnection(e)).toEqual({ apiBase: 'http://stored:1', apiToken: 'tok' })
  })

  it('includes a stored TLS fingerprint; absent (undefined) for plaintext', () => {
    const tls = env({ base: 'https://core:1', fingerprint: 'AB:CD:EF:01:23:45' })
    expect(resolveConnection(tls.env)).toEqual({
      apiBase: 'https://core:1',
      apiToken: '',
      apiFingerprint: 'AB:CD:EF:01:23:45'
    })
    const plain = env({ base: 'http://core:1' })
    expect(resolveConnection(plain.env)).toEqual({ apiBase: 'http://core:1', apiToken: '' })
  })
})

describe('saveConnection', () => {
  it('persists base (trailing slash trimmed) and token, then reloads', () => {
    const { env: e, reload } = env({ search: '?api=http://old:1' })
    saveConnection('http://192.168.1.50:47615/', 'pairing-tok', undefined, e)
    expect(e.localStorage.getItem('conductor.apiBase')).toBe('http://192.168.1.50:47615')
    expect(e.localStorage.getItem('conductor.apiToken')).toBe('pairing-tok')
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('clears a blank base so the fallback chain takes over again', () => {
    const { env: e, reload } = env({ base: 'http://old:1', token: 'old-tok' })
    saveConnection('   ', '', undefined, e)
    expect(e.localStorage.getItem('conductor.apiBase')).toBeNull()
    expect(e.localStorage.getItem('conductor.apiToken')).toBeNull()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('persists a TLS fingerprint when provided, then reloads', () => {
    const { env: e, reload } = env()
    saveConnection('https://192.168.1.50:47615', 'tok', 'AB:CD:EF:01', e)
    expect(e.localStorage.getItem('conductor.apiFingerprint')).toBe('AB:CD:EF:01')
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('clears a blank fingerprint so the link reads as plaintext', () => {
    const { env: e } = env({ fingerprint: 'AB:CD:EF:01' })
    saveConnection('https://core:1', 'tok', '   ', e)
    expect(e.localStorage.getItem('conductor.apiFingerprint')).toBeNull()
  })
})

describe('hasStoredConnection', () => {
  it('is false when nothing is stored', () => {
    expect(hasStoredConnection(env().env)).toBe(false)
  })

  it('is true when only a base is stored', () => {
    expect(hasStoredConnection(env({ base: 'http://core:1' }).env)).toBe(true)
  })

  it('is true when only a token is stored', () => {
    expect(hasStoredConnection(env({ token: 'tok' }).env)).toBe(true)
  })

  it('ignores whitespace-only stored values', () => {
    expect(hasStoredConnection(env({ base: '   ', token: '\t' }).env)).toBe(false)
  })
})

describe('forgetConnection', () => {
  it('removes base + token + fingerprint and reloads', () => {
    const { env: e, reload } = env({ base: 'http://core:1', token: 'pairing-tok', fingerprint: 'AB:CD:EF:01' })
    forgetConnection(e)
    expect(e.localStorage.getItem('conductor.apiBase')).toBeNull()
    expect(e.localStorage.getItem('conductor.apiToken')).toBeNull()
    expect(e.localStorage.getItem('conductor.apiFingerprint')).toBeNull()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('is a no-op on storage (still reloads) when nothing is stored', () => {
    const { env: e, reload } = env()
    forgetConnection(e)
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
