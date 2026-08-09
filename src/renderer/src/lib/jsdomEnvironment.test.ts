// @vitest-environment jsdom
import { describe, expect, test } from 'vitest'

/** Guards the per-file docblock opt-in that every component test depends on. */
describe('jsdom environment', () => {
  test('a test file can opt into a DOM without changing the global environment', () => {
    const node = document.createElement('div')
    node.textContent = 'ready'
    document.body.append(node)
    expect(document.body.textContent).toBe('ready')
  })
})
