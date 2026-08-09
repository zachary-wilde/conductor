import { describe, it, expect } from 'vitest'
import { classifyHarnessFailure, nextFallbackHarness } from './harness-fallback'
import type { HarnessId } from '@shared/types'

describe('classifyHarnessFailure', () => {
  it('treats quota / rate-limit / billing failures as dry', () => {
    for (const message of [
      'Claude headless turn exited 1: You have exceeded your quota',
      'Codex headless turn exited 1: 429 Too Many Requests',
      'error: rate limit reached for this model',
      'insufficient credit balance',
      'usage limit reached'
    ]) {
      expect(classifyHarnessFailure(message)).toBe('dry')
    }
  })

  it('treats auth / login failures as dry', () => {
    expect(classifyHarnessFailure('Error 401: unauthorized')).toBe('dry')
    expect(classifyHarnessFailure('You are not logged in. Run `claude login`.')).toBe('dry')
  })

  it('treats an unavailable / missing CLI as dry', () => {
    expect(classifyHarnessFailure('Codex is not available. Install it or set a custom path.')).toBe('dry')
    expect(classifyHarnessFailure('spawn codex ENOENT')).toBe('dry')
  })

  it('treats a genuine task failure or a timeout as not dry', () => {
    expect(classifyHarnessFailure('Claude headless turn exited 2: SyntaxError in tool block')).toBe('other')
    expect(classifyHarnessFailure('Claude headless turn timed out')).toBe('other')
    expect(classifyHarnessFailure('the manager turn was cancelled')).toBe('other')
    expect(classifyHarnessFailure('unexpected end of JSON input')).toBe('other')
  })

  it('is case-insensitive', () => {
    expect(classifyHarnessFailure('QUOTA EXCEEDED')).toBe('dry')
  })
})

describe('nextFallbackHarness', () => {
  const order: HarnessId[] = ['claude', 'codex', 'zai']
  const all = new Set<HarnessId>(['claude', 'codex', 'zai'])

  it('returns the next installed vendor after the current one', () => {
    expect(
      nextFallbackHarness({ current: 'claude', order, available: all, tried: new Set(['claude']) })
    ).toBe('codex')
  })

  it('skips the current, already-tried, and uninstalled vendors', () => {
    expect(
      nextFallbackHarness({
        current: 'claude',
        order,
        available: new Set<HarnessId>(['claude', 'zai']), // codex not installed
        tried: new Set<HarnessId>(['claude'])
      })
    ).toBe('zai')
    expect(
      nextFallbackHarness({
        current: 'codex',
        order,
        available: all,
        tried: new Set<HarnessId>(['claude', 'codex'])
      })
    ).toBe('zai')
  })

  it('returns null when the chain is exhausted', () => {
    expect(
      nextFallbackHarness({ current: 'zai', order, available: all, tried: all })
    ).toBeNull()
  })

  it('returns null when fallback is disabled (empty order)', () => {
    expect(
      nextFallbackHarness({ current: 'claude', order: [], available: all, tried: new Set(['claude']) })
    ).toBeNull()
  })
})
