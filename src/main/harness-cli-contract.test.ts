import { afterEach, describe, expect, test } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, type HarnessId, type Settings } from '@shared/types'
import { buildHeadlessCommand, runHeadlessHarness } from './harness'

const HARNESS_IDS: HarnessId[] = ['claude', 'codex', 'zai']
const FIXTURE = join(__dirname, '__fixtures__', 'harness-contract.cmd')
const MODEL = 'contract-model'
const EXTRA = ['--contract-extra', 'extra value']
const PROMPT = 'first line\nquoted line: "keep this quote" and trailing space \nlast line'

function settings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, harnessModels: {}, harnessArgs: {}, ...overrides }
}

describe('headless CLI contract', () => {
  test('builds the exact invocation contract for every harness', () => {
    const configured = settings({
      harnessModels: { claude: MODEL, codex: MODEL, zai: MODEL },
      harnessArgs: { claude: EXTRA, codex: EXTRA, zai: EXTRA }
    })

    expect(buildHeadlessCommand('claude', configured, PROMPT)).toEqual({
      args: ['-p', '--model', MODEL, ...EXTRA],
      stdin: PROMPT
    })
    expect(buildHeadlessCommand('codex', configured, PROMPT)).toEqual({
      args: ['exec', '--model', MODEL, '--sandbox', 'read-only', ...EXTRA, '-'],
      stdin: PROMPT
    })
    expect(buildHeadlessCommand('zai', configured, PROMPT)).toEqual({
      args: ['-p', '--model', MODEL, ...EXTRA, PROMPT],
      stdin: null
    })
  })
})

describe.skipIf(process.platform !== 'win32')('real Windows CLI launch contract', () => {
  const originalDummyHarness = process.env.CONDUCTOR_RAVEL_DUMMY_HARNESS

  afterEach(() => {
    if (originalDummyHarness === undefined) delete process.env.CONDUCTOR_RAVEL_DUMMY_HARNESS
    else process.env.CONDUCTOR_RAVEL_DUMMY_HARNESS = originalDummyHarness
    delete process.env.CONTRACT_CAPTURE
  })

  test.each(HARNESS_IDS)('%s preserves argv and stdin through cmd.exe /d /c', async (id) => {
    delete process.env.CONDUCTOR_RAVEL_DUMMY_HARNESS
    const cwd = mkdtempSync(join(tmpdir(), 'conductor-harness-contract-'))
    const capture = join(cwd, 'capture.json')
    process.env.CONTRACT_CAPTURE = capture

    try {
      const configured = settings({
        harnessPaths: { [id]: FIXTURE },
        harnessModels: { [id]: MODEL },
        harnessArgs: { [id]: EXTRA }
      })

      await runHeadlessHarness(id, configured, PROMPT, { cwd, timeoutMs: 30_000 })

      const received = JSON.parse(readFileSync(capture, 'utf8')) as { argv: string[]; stdin: string }
      const expected = {
        claude: { args: ['-p', '--model', MODEL, ...EXTRA], stdin: PROMPT },
        codex: { args: ['exec', '--model', MODEL, '--sandbox', 'read-only', ...EXTRA, '-'], stdin: PROMPT },
        zai: { args: ['-p', '--model', MODEL, ...EXTRA, PROMPT], stdin: null }
      }[id]

      expect(received.argv).toEqual(expected.args)
      expect(received.stdin).toBe(expected.stdin ?? '')
    } finally {
      delete process.env.CONTRACT_CAPTURE
      rmSync(cwd, { recursive: true, force: true })
    }
  }, 30_000)
})
