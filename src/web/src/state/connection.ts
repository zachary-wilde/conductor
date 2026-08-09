// Connection target + credentials for the operator web UI.
//
// This module is the single source of truth for WHERE the core lives and HOW to
// authenticate against it. The same SPA must work in three deployments with no
// code change:
//
//   1. Desktop — the core serves the bundle same-origin, no token (zero config).
//   2. Dev — `?api=http://127.0.0.1:<port>` points a standalone dev server at a
//      core bound to an ephemeral port.
//   3. Android APK (Capacitor) — the operator pairs the device with a PC core
//      over the LAN, persisting a base URL + access token so it survives
//      relaunches.
//
// The resolution precedence (localStorage → query → origin) and the empty-token
// allowance are the FROZEN auth contract; the server slice implements the
// mirror (401 on a missing/wrong token, permissive CORS). `resolveApiBase` /
// `resolveApiToken` accept an injectable {@link BrowserEnv} so the precedence is
// unit-testable without a DOM.

const BASE_KEY = 'conductor.apiBase'
const TOKEN_KEY = 'conductor.apiToken'
const FINGERPRINT_KEY = 'conductor.apiFingerprint'

/**
 * The resolved connection. `apiFingerprint` is present only when the pairing
 * carried one (TLS core); absent (undefined) means a plaintext (http) link.
 */
export interface ConnectionConfig {
  apiBase: string
  apiToken: string
  /** SHA-256 of the core's self-signed TLS cert (colon-hex), for display. */
  apiFingerprint?: string
}

/**
 * The browser globals the resolvers read. Injected only by tests; production
 * calls go through {@link defaultEnv}.
 */
export interface BrowserEnv {
  localStorage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  location: { search: string; origin: string; reload: () => void }
}

/** A trimmed, non-empty value — or null so callers can fall through cleanly (accepts nullish). */
function nonEmpty(s: string | null | undefined): string | null {
  if (s == null) return null
  const t = s.trim()
  return t.length > 0 ? t : null
}

/**
 * Resolve the API base. Precedence (frozen contract): `conductor.apiBase` in
 * localStorage → `?api=` query → the page's own origin (same-origin). A
 * trailing slash is trimmed. Whitespace-only stored/query values are ignored so
 * an accidental blank never shadows a working fallback.
 */
export function resolveApiBase(env: BrowserEnv = defaultEnv()): string {
  const stored = nonEmpty(env.localStorage.getItem(BASE_KEY))
  if (stored) return stored.replace(/\/+$/, '')
  const queried = nonEmpty(new URLSearchParams(env.location.search).get('api'))
  if (queried) return queried.replace(/\/+$/, '')
  return env.location.origin.replace(/\/+$/, '')
}

/**
 * Resolve the access token. Precedence: `conductor.apiToken` in localStorage →
 * `?token=` query → '' (empty; an unauthenticated core is allowed).
 */
export function resolveApiToken(env: BrowserEnv = defaultEnv()): string {
  const stored = nonEmpty(env.localStorage.getItem(TOKEN_KEY))
  if (stored) return stored
  return nonEmpty(new URLSearchParams(env.location.search).get('token')) ?? ''
}

/** Convenience: the full resolved connection (base + token, + fingerprint when TLS).
 * The fingerprint has no query fallback (unlike base/token) — it only comes from
 * a `C1:` pairing code persisted to localStorage; absent (undefined) = plaintext. */
export function resolveConnection(env: BrowserEnv = defaultEnv()): ConnectionConfig {
  return {
    apiBase: resolveApiBase(env),
    apiToken: resolveApiToken(env),
    apiFingerprint: nonEmpty(env.localStorage.getItem(FINGERPRINT_KEY)) ?? undefined
  }
}

/**
 * Persist the base + token (+ optional TLS fingerprint) to localStorage, then
 * reload the app so every in-flight URL (handshake, command, query, SSE)
 * re-resolves against the new values atomically. A blank base clears the stored
 * value (falling back to query/origin); a blank token clears the token
 * (unauthenticated); a blank/absent fingerprint clears it (plaintext). The
 * reload is the simplest correct reconnect — there is no stale connection to
 * drain.
 */
export function saveConnection(
  apiBase: string,
  apiToken: string,
  fingerprint?: string,
  env: BrowserEnv = defaultEnv()
): void {
  const base = nonEmpty(apiBase)
  if (base) env.localStorage.setItem(BASE_KEY, base.replace(/\/+$/, ''))
  else env.localStorage.removeItem(BASE_KEY)

  const token = nonEmpty(apiToken)
  if (token) env.localStorage.setItem(TOKEN_KEY, token)
  else env.localStorage.removeItem(TOKEN_KEY)

  // Carried for DISPLAY only — native cert PINNING (a Capacitor plugin) is out of scope here.
  const fp = nonEmpty(fingerprint)
  if (fp) env.localStorage.setItem(FINGERPRINT_KEY, fp)
  else env.localStorage.removeItem(FINGERPRINT_KEY)

  env.location.reload()
}

/**
 * Forget the saved connection: clears the persisted base + token + fingerprint from
 * localStorage, then reloads so the app re-resolves from scratch (on a paired
 * device the re-resolved origin cannot reach a core, so the Connect screen
 * re-pins and the device can be re-paired). The in-memory client is rebuilt by
 * the reload, so there is no stale paired target left running.
 */
export function forgetConnection(env: BrowserEnv = defaultEnv()): void {
  env.localStorage.removeItem(BASE_KEY)
  env.localStorage.removeItem(TOKEN_KEY)
  env.localStorage.removeItem(FINGERPRINT_KEY)
  env.location.reload()
}

/** Whether a base or token is currently persisted (i.e. the device is paired). */
export function hasStoredConnection(env: BrowserEnv = defaultEnv()): boolean {
  return (
    nonEmpty(env.localStorage.getItem(BASE_KEY)) !== null ||
    nonEmpty(env.localStorage.getItem(TOKEN_KEY)) !== null
  )
}

/** Production globals. Kept tiny so the module is trivially testable. */
function defaultEnv(): BrowserEnv {
  return { localStorage: window.localStorage, location: window.location }
}
