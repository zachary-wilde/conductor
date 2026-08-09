// Guards the client/server digest-parity contract the review view relies on:
// the SAME pure `reviewDiffDigest` runs in the browser bundle and the core, so a
// digest computed here must match one computed there for identical inputs. These
// tests pin the properties that make that parity load-bearing — determinism,
// order-independence, and sensitivity to each defining field.

import { describe, expect, it } from 'vitest'
import { reviewDiffDigest } from '@ops/review-digest'

describe('reviewDiffDigest (client/server parity)', () => {
  it('produces 16 lowercase hex characters', () => {
    expect(reviewDiffDigest({ baseCommit: 'b', headCommit: 'h', branch: 'main', changedFiles: ['a.ts'] })).toMatch(
      /^[0-9a-f]{16}$/
    )
  })

  it('is order-independent across changed files', () => {
    const a = reviewDiffDigest({ baseCommit: 'b', headCommit: 'h', branch: 'main', changedFiles: ['a.ts', 'b.ts'] })
    const b = reviewDiffDigest({ baseCommit: 'b', headCommit: 'h', branch: 'main', changedFiles: ['b.ts', 'a.ts'] })
    expect(a).toBe(b)
  })

  it('is deterministic for identical inputs', () => {
    const input = { baseCommit: 'b', headCommit: 'h', branch: 'main', changedFiles: ['a.ts'] }
    expect(reviewDiffDigest(input)).toBe(reviewDiffDigest(input))
  })

  it('changes when a changed file is added', () => {
    const base = reviewDiffDigest({ baseCommit: 'b', headCommit: 'h', branch: 'main', changedFiles: ['a.ts'] })
    const plus = reviewDiffDigest({ baseCommit: 'b', headCommit: 'h', branch: 'main', changedFiles: ['a.ts', 'b.ts'] })
    expect(base).not.toBe(plus)
  })

  it('changes when the head commit changes', () => {
    const a = reviewDiffDigest({ baseCommit: 'b', headCommit: 'h1', branch: 'main', changedFiles: [] })
    const b = reviewDiffDigest({ baseCommit: 'b', headCommit: 'h2', branch: 'main', changedFiles: [] })
    expect(a).not.toBe(b)
  })

  it('changes when the branch changes', () => {
    const a = reviewDiffDigest({ baseCommit: 'b', headCommit: 'h', branch: 'main', changedFiles: [] })
    const b = reviewDiffDigest({ baseCommit: 'b', headCommit: 'h', branch: 'dev', changedFiles: [] })
    expect(a).not.toBe(b)
  })
})
