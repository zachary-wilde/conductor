import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, HARNESS_MODEL_OPTIONS, type Settings } from '@shared/types'
import { resetModelCatalogueCache, resolveModelCatalogue, resolveModelCatalogues } from './harness'

function settings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, harnessModels: {}, harnessArgs: {}, ...overrides }
}

/**
 * A stand-in for an installed CLI, routed in through the same
 * `CONDUCTOR_RAVEL_DUMMY_HARNESS` hook the ravel smoke walkthrough uses, so the
 * catalogue probe spawns a genuine child process and parses genuine stdout.
 * `CATALOGUE_FAKE_MODE` picks which kind of CLI it is pretending to be.
 */
const FAKE_CLI = `
const mode = process.env.CATALOGUE_FAKE_MODE ?? 'ok'
const argv = process.argv.slice(2)
if (mode === 'hang') {
  setInterval(() => {}, 1000)
} else if (mode === 'garbage') {
  process.stdout.write('catalogue service unreachable, try again later\\n')
} else if (mode === 'truncated') {
  process.stdout.write('{"models":[{"slug":"gpt-5.6-sol"')
} else if (mode === 'empty') {
  process.stdout.write(JSON.stringify({ models: [] }))
} else if (mode === 'crash') {
  process.stderr.write('not logged in\\n')
  process.exit(3)
} else if (argv.includes('--json')) {
  process.stdout.write(
    'omp v17.2.1\\n' +
      JSON.stringify({
        models: [
          { provider: 'zai', id: 'glm-9', selector: 'zai/glm-9' },
          { provider: 'anthropic', id: 'claude-opus-9', selector: 'anthropic/claude-opus-9' },
          { provider: 'zai', id: 'glm-9', selector: 'zai/glm-9' },
          { provider: 'broken', id: 'no-selector' }
        ]
      })
  )
} else {
  process.stdout.write(
    JSON.stringify({
      models: [
        { slug: 'gpt-9-sol', visibility: 'list' },
        { slug: 'gpt-9-mini', visibility: 'list' },
        { slug: 'gpt-9-internal', visibility: 'hide' }
      ]
    })
  )
}
`

let fakeCli = ''

beforeEach(() => {
  resetModelCatalogueCache()
  fakeCli = join(mkdtempSync(join(tmpdir(), 'catalogue-')), 'fake-cli.mjs')
  writeFileSync(fakeCli, FAKE_CLI, 'utf8')
})

afterEach(() => {
  delete process.env.CONDUCTOR_RAVEL_DUMMY_HARNESS
  delete process.env.CATALOGUE_FAKE_MODE
})

function useFakeCli(mode: string): void {
  process.env.CONDUCTOR_RAVEL_DUMMY_HARNESS = fakeCli
  process.env.CATALOGUE_FAKE_MODE = mode
}

describe('live model enumeration', () => {
  test('codex reports its own slugs and drops the ones it marks hidden', async () => {
    useFakeCli('ok')

    const catalogue = await resolveModelCatalogue('codex', settings())

    expect(catalogue).toEqual({ models: ['gpt-9-sol', 'gpt-9-mini'], discovered: true })
  })

  test('omp reports fully-qualified selectors, deduped, past its version banner', async () => {
    useFakeCli('ok')

    const catalogue = await resolveModelCatalogue('zai', settings())

    // The banner line, the duplicate, and the selector-less entry are all
    // survivable; a real omp build prints all three at one time or another.
    expect(catalogue).toEqual({ models: ['zai/glm-9', 'anthropic/claude-opus-9'], discovered: true })
  })

  /**
   * Claude Code registers no model-listing subcommand at all -- `/model` is a
   * TUI slash command -- so there is nothing to probe and nothing to spawn.
   */
  test('claude stays on the static list because its CLI exposes no listing', async () => {
    useFakeCli('ok')

    const catalogue = await resolveModelCatalogue('claude', settings())

    expect(catalogue).toEqual({ models: HARNESS_MODEL_OPTIONS.claude, discovered: false })
  })
})

describe('falling back to the static catalogue', () => {
  test('a CLI that is not installed leaves model selection intact', async () => {
    // No dummy override and nothing on PATH, so no harness resolves.
    const previousPath = process.env.PATH
    process.env.PATH = mkdtempSync(join(tmpdir(), 'catalogue-empty-path-'))
    try {
      const catalogue = await resolveModelCatalogue('codex', settings())

      expect(catalogue).toEqual({ models: HARNESS_MODEL_OPTIONS.codex, discovered: false })
    } finally {
      process.env.PATH = previousPath
    }
  })

  /**
   * A real child process is the point here: the timeout has to actually kill a
   * CLI that never exits, which fake timers cannot demonstrate. Non-completion
   * is the failure mode under test, and vitest's own test timeout catches it.
   */
  test('a hanging CLI is killed at the timeout instead of stalling the caller', async () => {
    useFakeCli('hang')

    const catalogue = await resolveModelCatalogue('zai', settings(), { timeoutMs: 400 })

    expect(catalogue).toEqual({ models: HARNESS_MODEL_OPTIONS.zai, discovered: false })
  })

  test('output that is not JSON at all falls back rather than yielding an empty dropdown', async () => {
    useFakeCli('garbage')

    const catalogue = await resolveModelCatalogue('codex', settings())

    expect(catalogue).toEqual({ models: HARNESS_MODEL_OPTIONS.codex, discovered: false })
  })

  test('JSON that is cut off mid-payload falls back', async () => {
    useFakeCli('truncated')

    const catalogue = await resolveModelCatalogue('codex', settings())

    expect(catalogue).toEqual({ models: HARNESS_MODEL_OPTIONS.codex, discovered: false })
  })

  test('a well-formed but empty catalogue falls back, because a stale list beats no list', async () => {
    useFakeCli('empty')

    const catalogue = await resolveModelCatalogue('zai', settings())

    expect(catalogue).toEqual({ models: HARNESS_MODEL_OPTIONS.zai, discovered: false })
  })

  test('a non-zero exit falls back and never surfaces as a rejection', async () => {
    useFakeCli('crash')

    await expect(resolveModelCatalogue('codex', settings())).resolves.toEqual({
      models: HARNESS_MODEL_OPTIONS.codex,
      discovered: false
    })
  })
})

describe('catalogue caching', () => {
  test('the first result is reused for the process lifetime, so no second probe runs', async () => {
    useFakeCli('ok')
    const first = await resolveModelCatalogue('codex', settings())

    // A probe on the second call would now see a CLI that prints nothing usable.
    process.env.CATALOGUE_FAKE_MODE = 'garbage'
    const second = await resolveModelCatalogue('codex', settings())

    expect(second).toEqual(first)
    expect(second.discovered).toBe(true)
  })

  test('concurrent callers share one probe rather than racing several', async () => {
    useFakeCli('ok')

    const [a, b, c] = await Promise.all([
      resolveModelCatalogue('zai', settings()),
      resolveModelCatalogue('zai', settings()),
      resolveModelCatalogue('zai', settings())
    ])

    expect(a).toBe(b)
    expect(b).toBe(c)
  })

  test('every harness resolves together, each with its own outcome', async () => {
    useFakeCli('ok')

    const all = await resolveModelCatalogues(settings())

    expect(all.claude.discovered).toBe(false)
    expect(all.codex.models).toEqual(['gpt-9-sol', 'gpt-9-mini'])
    expect(all.zai.models).toEqual(['zai/glm-9', 'anthropic/claude-opus-9'])
  })
})
