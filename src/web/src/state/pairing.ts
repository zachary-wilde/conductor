// Device pairing codes for the operator web UI.
//
// The desktop core renders a scannable pairing code — `C1:` followed by a
// base64url-encoded `{ u, t, f? }` (core base URL + access token, plus an
// optional TLS cert fingerprint) — in its Remote access panel. The phone app
// either scans that QR or pastes the code here; this module turns the code
// back into a connection target that `saveConnection` persists. The `C1:`
// prefix is the format version so a future shape can be distinguished rather
// than silently mis-parsed.
//
// Pure and DOM-free (uses only `atob` + `TextDecoder`, both standard in the
// browser and in Node), so the decode is unit-tested without a camera or a DOM.

/** A decoded pairing target: the core base URL, its access token (possibly empty), and — when the
 * core serves TLS (CONDUCTOR_WEB_TLS) — the SHA-256 fingerprint of its self-signed cert, for display. */
export interface PairingTarget {
  u: string
  t: string
  /** Present only for TLS codes (`f` in the payload); colon-separated hex, e.g. `AB:CD:…`. */
  fingerprint?: string
}

/**
 * Decode a `C1:` pairing code into a {@link PairingTarget}, or null when the
 * code is absent, not valid base64url, or not the expected shape. A
 * missing/!string token decodes to `''` (an unauthenticated core is allowed),
 * matching the connection module's empty-token contract.
 *
 * The `C1:` version prefix is accepted but OPTIONAL: an operator who pastes
 * just the base64url payload (e.g. they trimmed the prefix thinking it was
 * decoration) still pairs. Any other version prefix (`C2:`…) or a plain URL
 * contains a `:`, which is not a base64url character, so `atob` rejects it and
 * the whole thing falls through to null — a bare payload never mis-decodes a
 * real URL or a future-format code.
 */
export function decodePairing(code: string): PairingTarget | null {
  const trimmed = code.trim()
  if (!trimmed) return null
  const payload = trimmed.startsWith('C1:') ? trimmed.slice(3) : trimmed
  try {
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/')
    const binary = atob(b64)
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (parsed && typeof parsed === 'object' && 'u' in parsed && typeof parsed.u === 'string') {
      const t = 't' in parsed && typeof parsed.t === 'string' ? parsed.t : ''
      // `f` is optional: present only when the core serves TLS (CONDUCTOR_WEB_TLS),
      // carrying the cert's SHA-256 fingerprint for the operator to confirm + pin.
      const fingerprint = 'f' in parsed && typeof parsed.f === 'string' ? parsed.f : undefined
      return fingerprint ? { u: parsed.u, t, fingerprint } : { u: parsed.u, t }
    }
  } catch {
    // Malformed base64/JSON is just an invalid code — the caller shows an error.
  }
  return null
}
