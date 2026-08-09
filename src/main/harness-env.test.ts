import { describe, expect, test } from 'vitest'
import { harnessEnv } from './harness'

/**
 * Claude Code disables the claude.ai login the moment it sees ANTHROPIC_API_KEY,
 * so inheriting one from the user's environment silently bills a metered API
 * account instead of the subscription they already pay for. Observed on a real
 * manager turn: "connectors are disabled because ANTHROPIC_API_KEY or another
 * auth source is set and takes precedence over your claude.ai login".
 */
describe('harness child environment', () => {
  test('drops the API key that would override a claude.ai login', () => {
    const { env, stripped } = harnessEnv('claude', {
      PATH: 'C:/bin',
      ANTHROPIC_API_KEY: 'test-not-a-real-key'
    })
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(stripped).toEqual(['ANTHROPIC_API_KEY'])
    expect(env.PATH).toBe('C:/bin')
  })

  test('drops an auth token as well as an api key', () => {
    const { stripped } = harnessEnv('claude', {
      ANTHROPIC_API_KEY: 'a',
      ANTHROPIC_AUTH_TOKEN: 'b'
    })
    expect(stripped.sort()).toEqual(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'])
  })

  test('reports nothing when there was no conflict to resolve', () => {
    const { env, stripped } = harnessEnv('claude', { PATH: 'C:/bin' })
    expect(stripped).toEqual([])
    expect(env.PATH).toBe('C:/bin')
  })

  test('an empty value is not treated as a credential', () => {
    const { stripped } = harnessEnv('claude', { ANTHROPIC_API_KEY: '' })
    expect(stripped).toEqual([])
  })

  /** Only claude has been observed to refuse; the others keep their environment. */
  test('leaves codex and zai environments alone', () => {
    for (const id of ['codex', 'zai'] as const) {
      const { env, stripped } = harnessEnv(id, { ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'b' })
      expect(stripped).toEqual([])
      expect(env.ANTHROPIC_API_KEY).toBe('a')
      expect(env.OPENAI_API_KEY).toBe('b')
    }
  })

  test('extra vars are applied and can still be stripped', () => {
    const { env, stripped } = harnessEnv('claude', { PATH: 'C:/bin' }, {
      CONDUCTOR_RAVEL_CAP: 'cap',
      ANTHROPIC_API_KEY: 'leaked-in-later'
    })
    expect(env.CONDUCTOR_RAVEL_CAP).toBe('cap')
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(stripped).toEqual(['ANTHROPIC_API_KEY'])
  })

  test('does not mutate the environment it was given', () => {
    const base = { ANTHROPIC_API_KEY: 'a', PATH: 'C:/bin' }
    harnessEnv('claude', base)
    expect(base.ANTHROPIC_API_KEY).toBe('a')
  })
})
