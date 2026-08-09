/** Cross-platform basename/dirname using forward-slash normalization. */
export function basename(p: string): string {
  const norm = p.replace(/\\/g, '/')
  const parts = norm.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? p
}

export function dirname(p: string): string {
  const norm = p.replace(/\\/g, '/')
  const idx = norm.lastIndexOf('/')
  return idx > 0 ? norm.slice(0, idx) : '.'
}
