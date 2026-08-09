import { afterEach, describe, expect, test } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, type Settings } from '@shared/types'
import { buildHeadlessCommand, buildLaunchArgs, detectHarnesses, resolveHarness, runHeadlessHarness } from './harness'
import { parseToolCalls } from './manager-turn'

function settings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, harnessModels: {}, harnessArgs: {}, ...overrides }
}

describe('buildLaunchArgs model selection', () => {
  test('omits --model when neither an override nor a harness default exists', () => {
    expect(buildLaunchArgs('claude', settings())).toEqual([])
  })

  test('uses the harness default model from settings', () => {
    const args = buildLaunchArgs('zai', settings({ harnessModels: { zai: 'zai/glm-5.2' } }))
    expect(args).toEqual(['--model', 'zai/glm-5.2'])
  })

  test('per-session override beats the harness default', () => {
    const args = buildLaunchArgs('claude', settings({ harnessModels: { claude: 'sonnet' } }), undefined, {
      model: 'opus'
    })
    expect(args).toEqual(['--model', 'opus'])
  })

  test('blank or whitespace models fall through to no flag rather than an empty value', () => {
    expect(buildLaunchArgs('claude', settings({ harnessModels: { claude: '   ' } }))).toEqual([])
    expect(buildLaunchArgs('claude', settings({ harnessModels: { claude: 'sonnet' } }), undefined, { model: '  ' })).toEqual([])
  })

  test('model precedes user args, auto-approve flag, and the positional prompt', () => {
    const args = buildLaunchArgs(
      'claude',
      settings({ harnessModels: { claude: 'opus' }, harnessArgs: { claude: ['--verbose'] } }),
      'do the thing',
      { autoApprove: true }
    )
    expect(args).toEqual(['--model', 'opus', '--verbose', '--dangerously-skip-permissions', 'do the thing'])
  })
})

describe('dummy harness override', () => {
  const script = join(__dirname, '..', '..', 'scripts', 'ravel-dummy-harness.mjs')

  afterEach(() => {
    delete process.env.CONDUCTOR_RAVEL_DUMMY_HARNESS
    delete process.env.CONDUCTOR_RAVEL_DUMMY_NODE
  })

  test('is inert unless the environment variable points at an existing file', async () => {
    process.env.CONDUCTOR_RAVEL_DUMMY_HARNESS = join(__dirname, 'does-not-exist.mjs')
    const detected = await detectHarnesses(settings())
    expect(detected.every((entry) => entry.resolved?.resolvedFrom !== script)).toBe(true)
  })

  test('routes every harness through the script so no paid CLI can launch', async () => {
    process.env.CONDUCTOR_RAVEL_DUMMY_HARNESS = script
    const detected = await detectHarnesses(settings({ harnessPaths: { claude: 'C:/real/claude.exe' } }))

    expect(detected).toHaveLength(3)
    for (const entry of detected) {
      expect(entry.available).toBe(true)
      expect(entry.resolved?.args).toEqual([script])
      expect(entry.resolved?.resolvedFrom).toBe(script)
      // Never the real CLI, whatever the operator configured.
      expect(entry.resolved?.command).not.toBe('C:/real/claude.exe')
    }

    const resolved = await resolveHarness('zai', settings())
    expect(resolved.args).toEqual([script])
  })

  /**
   * electron.exe is a GUI-subsystem image with no console handles, so a child
   * launched through it writes into the void under ConPTY. A real node is
   * preferred precisely so the double can produce output worth metering.
   */
  test('prefers a console-subsystem node over electron-as-node', async () => {
    process.env.CONDUCTOR_RAVEL_DUMMY_HARNESS = script
    process.env.CONDUCTOR_RAVEL_DUMMY_NODE = script
    const [entry] = await detectHarnesses(settings())
    expect(entry.resolved?.command).toBe(script)
    expect(entry.resolved?.env).toEqual({})
  })

  test('falls back to electron in node mode when no node binary exists', async () => {
    process.env.CONDUCTOR_RAVEL_DUMMY_HARNESS = script
    process.env.CONDUCTOR_RAVEL_DUMMY_NODE = ''
    const realPath = process.env.PATH
    process.env.PATH = ''
    try {
      const [entry] = await detectHarnesses(settings())
      expect(entry.resolved?.command).toBe(process.execPath)
      expect(entry.resolved?.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
    } finally {
      process.env.PATH = realPath
    }
  })
})

describe('headless manager invocation', () => {
  const prompt = 'compile a plan\nwith a second line'

  test('cmd.exe-shimmed CLIs take the prompt on stdin, never as a multi-line argv element', () => {
    // claude/codex resolve to npm .cmd shims launched via `cmd.exe /d /c`, and
    // cmd.exe cannot carry a newline inside an argument.
    expect(buildHeadlessCommand('claude', settings(), prompt)).toEqual({ args: ['-p'], stdin: prompt })
    expect(buildHeadlessCommand('codex', settings(), prompt)).toEqual({
      args: ['exec', '--sandbox', 'read-only', '-'],
      stdin: prompt
    })
  })

  test('omp is a real exe that ignores stdin in print mode, so its prompt rides on argv', () => {
    expect(buildHeadlessCommand('zai', settings(), prompt)).toEqual({ args: ['-p', prompt], stdin: null })
  })

  test('model and reasoning selection still apply to a headless turn', () => {
    const built = buildHeadlessCommand('zai', settings({ harnessModels: { zai: 'zai/glm-5.2:medium' } }), 'go')
    expect(built.args).toEqual(['-p', '--model', 'zai/glm-5.2:medium', 'go'])
  })

  test('codex takes --model after the subcommand, where the exec flag actually lives', () => {
    const built = buildHeadlessCommand('codex', settings({ harnessModels: { codex: 'gpt-5.6' } }), 'go')
    expect(built.args).toEqual(['exec', '--model', 'gpt-5.6', '--sandbox', 'read-only', '-'])
  })

  test('a headless turn never carries the interactive auto-approve flag', () => {
    const built = buildHeadlessCommand('claude', settings(), 'go')
    expect(built.args).not.toContain('--dangerously-skip-permissions')
  })

  test('user harness args are preserved, and stay ahead of the stdin marker or prompt', () => {
    expect(buildHeadlessCommand('claude', settings({ harnessArgs: { claude: ['--verbose'] } }), 'go').args).toEqual([
      '-p',
      '--verbose'
    ])
    expect(buildHeadlessCommand('codex', settings({ harnessArgs: { codex: ['--full-auto'] } }), 'go').args).toEqual([
      'exec',
      '--sandbox',
      'read-only',
      '--full-auto',
      '-'
    ])
    expect(buildHeadlessCommand('zai', settings({ harnessArgs: { zai: ['--no-tools'] } }), 'go').args).toEqual([
      '-p',
      '--no-tools',
      'go'
    ])
  })
})

/**
 * The transport itself, spawned for real against the dummy harness: no AI quota,
 * but a genuine child process, genuine stdin delivery, and genuine stdout
 * parsing. This is the part that the old pty manager got wrong.
 */
describe('runHeadlessHarness against the dummy harness', () => {
  const script = join(__dirname, '..', '..', 'scripts', 'ravel-dummy-harness.mjs')
  let logFile = ''

  afterEach(() => {
    delete process.env.CONDUCTOR_RAVEL_DUMMY_HARNESS
    delete process.env.CONDUCTOR_RAVEL_DUMMY_LOG
  })

  function prompt(directive: string): string {
    return ['You are Ravel.', '(no plan yet)', '=== THIS TURN ===', directive].join('\n')
  }

  test.each([
    ['claude', 'stdin'],
    ['zai', 'argv']
  ] as const)('a %s turn delivers a multi-line prompt by %s and returns parseable tool calls', async (id, _delivery) => {
    process.env.CONDUCTOR_RAVEL_DUMMY_HARNESS = script
    logFile = join(mkdtempSync(join(tmpdir(), 'ravel-headless-')), 'turn.log')
    process.env.CONDUCTOR_RAVEL_DUMMY_LOG = logFile

    const stdout = await runHeadlessHarness(id, settings(), prompt('EVENT: the user sent a message.\nsourceMessageId: m-7'), {
      timeoutMs: 30_000
    })

    expect(parseToolCalls(stdout)).toEqual([
      expect.objectContaining({ tool: 'propose_plan', sourceMessageIds: ['m-7'] })
    ])
    // The whole prompt survived the trip, newlines and all.
    expect(readFileSync(logFile, 'utf8')).toContain('sourceMessageId: m-7')
  })

  test('a non-zero exit surfaces as a thrown turn error, never as silent empty output', async () => {
    process.env.CONDUCTOR_RAVEL_DUMMY_HARNESS = script
    // The dummy exits 2 when it has nowhere to record what it was given.
    await expect(runHeadlessHarness('claude', settings(), prompt('EVENT: anything'), { timeoutMs: 30_000 })).rejects.toThrow(
      /exited 2/
    )
  })
})
