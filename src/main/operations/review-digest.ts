// REVIEW-DIGEST slice of the Operations Core: a PURE, deterministic fingerprint
// of what a review is being asked to land.
//
// Before a review's diff is applied, the operator (and the review UI) needs to
// know whether the diff is still fresh — i.e. whether the tree the reviewer
// signed off on is the same tree that would land. The cheap, side-effect-free
// way to express "the same tree" is a short digest over the exact set of inputs
// that define the diff: the base commit, the head commit, the branch, and the
// sorted list of changed files. If any of those drift between sign-off and
// landing, the digest changes and the review is flagged stale.
//
// Two properties matter here, and they drive every design choice:
//
//   1. DETERMINISM. The digest is a pure total function of its inputs. The order
//      in which changedFiles arrive MUST NOT affect the result, so the inputs are
//      canonicalized (deduped, then sorted with the default string comparator)
//      before anything is hashed.
//
//   2. NODE / BROWSER PARITY. The digest is computed on the server when a review
//      is recorded AND on the client when it is about to be landed, and the two
//      must compare equal. That rules out node:crypto (no synchronous SHA in the
//      browser) and any hash seeded from a clock or Math.random. We use FNV-1a
//      64-bit: a textbook non-cryptographic hash with a tiny, well-known table,
//      expressible in a handful of BigInt operations and identical in every JS
//      runtime. It is not collision-resistant against an adversary, but it does
//      not need to be — its only job is to detect accidental staleness, and its
//      64-bit space makes a benign collision astronomically unlikely.
//
// FNV-1a 64-bit (the variant chosen here) is defined as:
//   hash = 0xcbf29ce484222325 (the FNV offset basis)
//   for each input unit u: hash = (hash XOR u) * 0x100000001b3 mod 2^64
// We iterate UTF-16 code units (charCodeAt) rather than UTF-8 bytes. This keeps
// the hash a pure function of the JS string with no dependency on a TextEncoder,
// so it is byte-for-byte identical in Node, the renderer, and any other host.
// Every unit the hash consumes is below 2^16, so the XOR never escapes 64 bits;
// the multiply is masked back into 64 bits each step. For the ASCII git
// identifiers and file paths this digest is built from, UTF-16 code units and
// UTF-8 bytes coincide anyway, so the result is also the canonical byte-oriented
// FNV-1a in practice.
//
// This module performs no I/O, reads no clock, and imports nothing but types.

// FNV-1a 64-bit constants. Defined by the algorithm; never edit.
const FNV1A_64_OFFSET_BASIS = 0xcbf29ce484222325n
const FNV1A_64_PRIME = 0x100000001b3n
const UINT64_MASK = (1n << 64n) - 1n

/**
 * FNV-1a 64-bit over the UTF-16 code units of `input`, rendered as 16 lowercase
 * hex characters. See the module header for why code units (not bytes) and why
 * this particular hash. The result is masked into 64 bits and zero-padded so
 * short digests keep their width — FNV outputs are uniform, so a leading zero
 * turns up ~1/16 of the time.
 */
function fnv1a64(input: string): string {
  let hash = FNV1A_64_OFFSET_BASIS
  for (let i = 0; i < input.length; i++) {
    hash = ((hash ^ BigInt(input.charCodeAt(i))) * FNV1A_64_PRIME) & UINT64_MASK
  }
  return (hash & UINT64_MASK).toString(16).padStart(16, '0')
}

/**
 * A stable, order-independent fingerprint of a review's diff, used to detect
 * staleness before landing. Same inputs (in any order) always yield the same 16
 * lowercase hex characters; change any one of the commits, the branch, or the
 * set of files and the digest changes. Pure and synchronous, with identical
 * output in Node and the browser.
 *
 * Inputs are reduced to a single, order-independent form first: exact-duplicate
 * paths are dropped (Set membership) and the survivors are sorted with the
 * default string comparator (stable and locale-independent). The four fields are
 * then joined with `\n` so a value can never bleed into an adjacent field — e.g.
 * a branch named `a\nb` cannot mimic a changed file. An empty `changedFiles`
 * list is valid and yields a trailing newline after the branch.
 *
 * @param input The diff-defining inputs. `changedFiles` is an unordered set.
 * @returns 16 lowercase hex characters (the FNV-1a 64-bit digest).
 */
export function reviewDiffDigest(input: {
  baseCommit: string
  headCommit: string
  branch: string
  changedFiles: readonly string[]
}): string {
  const sortedUnique = Array.from(new Set(input.changedFiles)).sort()
  const canonical = [input.baseCommit, input.headCommit, input.branch, sortedUnique.join('\n')].join('\n')
  return fnv1a64(canonical)
}
