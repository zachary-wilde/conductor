// Pure validation + normalization for the Connect form's Core URL.
//
// The core is reached at an `http(s)://host:port` base; everything the client
// requests is built as `apiBase + '/api/...'`. A stray trailing slash or a
// non-URL typed into the field would produce broken request paths or confusing
// fetch failures, so the form validates before saving. Kept pure (no DOM, no
// network) so it is unit-testable and reusable from the pairing path.

export type CoreUrlResult = { ok: true; url: string } | { ok: false; error: string }

/**
 * Validate a Core URL and normalize it: require an `http://`/`https://` origin
 * and strip any trailing slash so request paths join cleanly. Returns the
 * normalized bare base on success, or a friendly inline error on failure.
 */
export function normalizeCoreUrl(input: string): CoreUrlResult {
  const trimmed = input.trim()
  if (!trimmed) return { ok: false, error: 'Enter a Core URL.' }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, error: 'Enter a full URL, e.g. http://192.168.1.50:47615' }
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'Core URL must start with http:// or https://' }
  }

  // Drop trailing slashes from any path so `apiBase + '/api/...'` joins once.
  const path = parsed.pathname.replace(/\/+$/, '')
  return { ok: true, url: parsed.origin + path }
}
