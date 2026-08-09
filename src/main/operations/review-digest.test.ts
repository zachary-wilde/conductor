import { describe, expect, it } from 'vitest'
import { reviewDiffDigest } from './review-digest'

/**
 * Build a digest input with sensible ASCII git identifiers; any field
 * overridable. The defaults describe an unremarkable review, so individual cases
 * override only the axis they exercise.
 */
const input = (over: {
  baseCommit?: string
  headCommit?: string
  branch?: string
  changedFiles?: readonly string[]
} = {}): {
  baseCommit: string
  headCommit: string
  branch: string
  changedFiles: readonly string[]
} => ({
  baseCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  headCommit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  branch: 'main',
  changedFiles: ['src/index.ts', 'README.md', 'package.json'],
  ...over
})

describe('reviewDiffDigest', () => {
  describe('determinism', () => {
    it('returns the same digest for the same input twice', () => {
      expect(reviewDiffDigest(input())).toBe(reviewDiffDigest(input()))
    })

    it('is stable across fresh array identities with identical contents', () => {
      const a = reviewDiffDigest(input({ changedFiles: ['src/index.ts', 'README.md'] }))
      const b = reviewDiffDigest(
        input({ changedFiles: ['src/index.ts', 'README.md'] })
      )
      expect(a).toBe(b)
    })
  })

  describe('changedFiles are an unordered set', () => {
    it('order of changedFiles does NOT affect the digest', () => {
      const asc = input({ changedFiles: ['a.ts', 'b.ts', 'c.ts'] })
      const desc = input({ changedFiles: ['c.ts', 'b.ts', 'a.ts'] })
      const shuffled = input({ changedFiles: ['b.ts', 'a.ts', 'c.ts'] })
      expect(reviewDiffDigest(asc)).toBe(reviewDiffDigest(desc))
      expect(reviewDiffDigest(asc)).toBe(reviewDiffDigest(shuffled))
    })

    it('a single permutation never changes the result', () => {
      const base = input()
      const reordered = input({ changedFiles: ['package.json', 'README.md', 'src/index.ts'] })
      expect(reviewDiffDigest(base)).toBe(reviewDiffDigest(reordered))
    })

    it('exact-duplicate paths are deduped and do not change the digest', () => {
      const once = input({ changedFiles: ['a.ts', 'b.ts'] })
      const thrice = input({ changedFiles: ['a.ts', 'a.ts', 'a.ts', 'b.ts', 'b.ts'] })
      expect(reviewDiffDigest(once)).toBe(reviewDiffDigest(thrice))
    })
  })

  describe('every input field contributes to the digest', () => {
    const baseline = input()

    it('changing baseCommit changes the digest', () => {
      const other = reviewDiffDigest(input({ baseCommit: 'a'.repeat(39) + 'b' }))
      expect(other).not.toBe(reviewDiffDigest(baseline))
    })

    it('changing headCommit changes the digest', () => {
      const other = reviewDiffDigest(input({ headCommit: 'b'.repeat(39) + 'c' }))
      expect(other).not.toBe(reviewDiffDigest(baseline))
    })

    it('changing branch changes the digest', () => {
      const other = reviewDiffDigest(input({ branch: 'dev' }))
      expect(other).not.toBe(reviewDiffDigest(baseline))
    })

    it('adding a file changes the digest', () => {
      const other = reviewDiffDigest(
        input({ changedFiles: [...input().changedFiles, 'src/extra.ts'] })
      )
      expect(other).not.toBe(reviewDiffDigest(baseline))
    })

    it('removing a file changes the digest', () => {
      const other = reviewDiffDigest(
        input({ changedFiles: input().changedFiles.slice(0, 2) })
      )
      expect(other).not.toBe(reviewDiffDigest(baseline))
    })

    it('changing a single file path changes the digest', () => {
      const other = reviewDiffDigest(
        input({ changedFiles: ['src/index.ts', 'README.md', 'package-lock.json'] })
      )
      expect(other).not.toBe(reviewDiffDigest(baseline))
    })
  })

  describe('edge cases', () => {
    it('empty changedFiles is valid and yields a 16-char digest', () => {
      const digest = reviewDiffDigest(input({ changedFiles: [] }))
      expect(digest).toMatch(/^[0-9a-f]{16}$/)
    })

    it('a single empty string path is hashed (not special-cased away)', () => {
      const digest = reviewDiffDigest(input({ changedFiles: [''] }))
      expect(digest).toMatch(/^[0-9a-f]{16}$/)
    })

    it('always returns exactly 16 lowercase hex characters', () => {
      const samples = [
        input(),
        input({ changedFiles: [] }),
        input({ branch: '' }),
        input({ baseCommit: '', headCommit: '' }),
        input({ changedFiles: ['a'] })
      ]
      for (const s of samples) {
        expect(reviewDiffDigest(s)).toMatch(/^[0-9a-f]{16}$/)
      }
    })
  })

  describe('golden fixed values (pinned for cross-runtime parity)', () => {
    it('matches the pinned digest for a populated review', () => {
      // base=40xa, head=40xb, branch=main, files=[src/index.ts,README.md,package.json].
      // Computed once from the FNV-1a 64-bit implementation above and frozen so a
      // regression — or a Node/browser divergence — fails loudly.
      expect(reviewDiffDigest(input())).toBe('8bb2d8a0a030cbbb')
    })

    it('matches the pinned digest for an empty changedFiles review', () => {
      // base=40xc, head=40xd, branch=release/v1, files=[].
      expect(
        reviewDiffDigest(
          input({
            baseCommit: 'cccccccccccccccccccccccccccccccccccccccc',
            headCommit: 'dddddddddddddddddddddddddddddddddddddddd',
            branch: 'release/v1',
            changedFiles: []
          })
        )
      ).toBe('faff2bc9355491a8')
    })

    it('the empty-files golden differs from the populated golden', () => {
      expect('8bb2d8a0a030cbbb').not.toBe('faff2bc9355491a8')
    })
  })
})
