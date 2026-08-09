import { describe, expect, it } from 'vitest'
import type { ReviewDiffContent } from '@ops/api-contract'
import { fileContentNote, fileStatusBadge, parseUnifiedDiff } from './diff'

describe('parseUnifiedDiff', () => {
  it('returns [] for an empty patch', () => {
    expect(parseUnifiedDiff('')).toEqual([])
  })

  it('parses a multi-hunk patch into the right line kinds + line numbers', () => {
    const patch = [
      'diff --git a/foo.txt b/foo.txt',
      'index 111..222 100644',
      '--- a/foo.txt',
      '+++ b/foo.txt',
      '@@ -1,3 +1,4 @@',
      ' context-1',
      '-removed',
      '+added',
      '+another',
      ' context-2',
      '@@ -10,2 +11,2 @@',
      ' keep',
      '-old',
      '+new'
    ].join('\n')

    const hunks = parseUnifiedDiff(patch)
    // preamble block + two real hunks
    expect(hunks).toHaveLength(3)

    // preamble: empty header, all meta
    expect(hunks[0].header).toBe('')
    expect(hunks[0].lines.map((l) => l.kind)).toEqual(['meta', 'meta', 'meta', 'meta'])
    expect(hunks[0].lines[0]).toMatchObject({
      kind: 'meta',
      text: 'diff --git a/foo.txt b/foo.txt',
      oldNo: null,
      newNo: null
    })

    // first hunk: line kinds + tracked numbers
    expect(hunks[1].header).toBe('@@ -1,3 +1,4 @@')
    const h1 = hunks[1].lines
    expect(h1.map((l) => l.kind)).toEqual(['context', 'del', 'add', 'add', 'context'])
    expect(h1[0]).toMatchObject({ kind: 'context', text: 'context-1', oldNo: 1, newNo: 1 })
    expect(h1[1]).toMatchObject({ kind: 'del', text: 'removed', oldNo: 2, newNo: null })
    expect(h1[2]).toMatchObject({ kind: 'add', text: 'added', oldNo: null, newNo: 2 })
    expect(h1[3]).toMatchObject({ kind: 'add', text: 'another', oldNo: null, newNo: 3 })
    expect(h1[4]).toMatchObject({ kind: 'context', text: 'context-2', oldNo: 3, newNo: 4 })

    // second hunk: counters reset from its own header
    expect(hunks[2].header).toBe('@@ -10,2 +11,2 @@')
    const h2 = hunks[2].lines
    expect(h2.map((l) => l.kind)).toEqual(['context', 'del', 'add'])
    expect(h2[0]).toMatchObject({ kind: 'context', text: 'keep', oldNo: 10, newNo: 11 })
    expect(h2[1]).toMatchObject({ kind: 'del', text: 'old', oldNo: 11, newNo: null })
    expect(h2[2]).toMatchObject({ kind: 'add', text: 'new', oldNo: null, newNo: 12 })
  })

  it('classifies a rename preamble as meta', () => {
    const patch = [
      'diff --git a/old.txt b/new.txt',
      'similarity index 95%',
      'rename from old.txt',
      'rename to new.txt',
      '--- a/old.txt',
      '+++ b/new.txt'
    ].join('\n')

    const hunks = parseUnifiedDiff(patch)
    expect(hunks).toHaveLength(1)
    expect(hunks[0].header).toBe('')
    expect(hunks[0].lines.every((l) => l.kind === 'meta')).toBe(true)
    expect(hunks[0].lines.map((l) => l.text)).toContain('rename from old.txt')
  })

  it('classifies the no-newline marker as meta without advancing numbers', () => {
    const patch = [
      '@@ -1,2 +1,2 @@',
      '-old',
      '\\ No newline at end of file',
      '+new'
    ].join('\n')

    const hunks = parseUnifiedDiff(patch)
    const marker = hunks[0].lines.find((l) => l.text.startsWith('\\'))
    expect(marker).toMatchObject({ kind: 'meta', oldNo: null, newNo: null })
    // the add line after the marker still gets the right new number
    const add = hunks[0].lines.find((l) => l.kind === 'add')
    expect(add).toMatchObject({ kind: 'add', newNo: 1 })
  })
})

describe('fileStatusBadge', () => {
  it('maps each status to a label + tone', () => {
    expect(fileStatusBadge('added')).toEqual({ label: 'added', tone: 'green' })
    expect(fileStatusBadge('deleted')).toEqual({ label: 'deleted', tone: 'red' })
    expect(fileStatusBadge('modified')).toEqual({ label: 'modified', tone: 'blue' })
    expect(fileStatusBadge('renamed')).toEqual({ label: 'renamed', tone: 'blue' })
  })
})

describe('fileContentNote', () => {
  it('returns null for plain text', () => {
    expect(fileContentNote('text')).toBeNull()
  })

  it('returns an amber note for every non-text content', () => {
    const contents: ReviewDiffContent[] = ['binary', 'oversized', 'truncated']
    for (const c of contents) {
      const note = fileContentNote(c)
      expect(note).not.toBeNull()
      expect(note?.tone).toBe('amber')
      expect(note?.label.length).toBeGreaterThan(0)
    }
  })

  it('uses the spec wording for each not-shown state', () => {
    expect(fileContentNote('binary')?.label).toBe('Binary file (not shown)')
    expect(fileContentNote('oversized')?.label).toBe('Diff too large to display')
    expect(fileContentNote('truncated')?.label).toBe('Not shown — review size limit reached')
  })
})
