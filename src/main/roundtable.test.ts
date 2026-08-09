import { afterEach, describe, expect, test } from 'vitest'
import { DEFAULT_SETTINGS, type RoundtableConfig, type Settings } from '@shared/types'
import {
  addNote,
  createRoundtable,
  deleteRoundtable,
  getRoundtable,
  pauseRoundtable,
  runRoundtable,
  setRoundtableEmitter,
  setRoundtableServicesForTest
} from './roundtable'

/**
 * A roundtable spends real quota to produce an argument, so the properties
 * worth guarding are the ones that decide how much it spends and what each
 * seat is allowed to know: strict alternation, a hard turn cap, the ceiling,
 * and a transcript that carries this table and nothing else.
 *
 * Every model invocation is faked at the service seam — no processes, no
 * models, no store.
 */

const SETTINGS: Settings = { ...DEFAULT_SETTINGS }

interface Fake {
  /** Every prompt a seat was invoked with, in order. */
  prompts: string[]
  /** Scripted replies, consumed one per invocation. */
  script: string[]
  records: Map<string, RoundtableConfig>
  updates: RoundtableConfig[]
  /**
   * How a seat answers. Swappable so a test can hold a turn open — replacing
   * the whole service seam mid-test would drop the fake store with it.
   */
  respond: (prompt: string) => string | Promise<string>
}

function harness(): Fake {
  const fake: Fake = {
    prompts: [],
    script: [],
    records: new Map(),
    updates: [],
    respond: () => fake.script.shift() ?? 'I have nothing to add.'
  }
  setRoundtableEmitter((_channel, ...args) => {
    const cfg = args[0]
    if (cfg && typeof cfg === 'object' && 'seats' in cfg) fake.updates.push(cfg as RoundtableConfig)
  })
  setRoundtableServicesForTest({
    runHeadlessHarness: async (_id, _settings, prompt) => {
      fake.prompts.push(prompt)
      return fake.respond(prompt)
    },
    repoSnapshot: async () => 'branch: main\n\nrecent commits:\nabc1234 seed',
    getSettings: () => SETTINGS,
    listRoundtables: () => [...fake.records.values()],
    getRoundtable: (id) => fake.records.get(id),
    addRoundtable: (cfg) => {
      fake.records.set(cfg.id, cfg)
      return cfg
    },
    replaceRoundtable: (id, cfg) => {
      if (!fake.records.has(id)) return undefined
      fake.records.set(id, cfg)
      return cfg
    },
    removeRoundtable: (id) => {
      fake.records.delete(id)
    }
  })
  return fake
}

/** Every fake resolves immediately, so draining microtasks is enough. */
async function settle(): Promise<void> {
  for (let i = 0; i < 100; i += 1) await Promise.resolve()
}

function table(overrides: Partial<Parameters<typeof createRoundtable>[0]> = {}): RoundtableConfig {
  const created = createRoundtable(
    {
      name: 'Strategy',
      repoId: 'repo-1',
      repoPath: 'C:/repo',
      topic: 'What should we do about the auth refresh drops?',
      seats: [
        { name: 'Opus', harness: 'claude', model: 'opus', stance: 'Argue for the smallest change that works.' },
        { name: 'GPT', harness: 'codex', model: 'gpt-5.5', stance: 'Attack the plan for risk and hidden cost.' }
      ],
      ...overrides
    }
  )
  if (!created.ok) throw new Error(`expected create to succeed: ${created.error.code}`)
  return created.roundtable
}

afterEach(() => {
  setRoundtableServicesForTest(null)
  setRoundtableEmitter(() => {})
})

describe('Roundtable deliberation (no quota spend)', () => {
  test('seats speak in strict rotation and each one hears what the others actually said', async () => {
    const fake = harness()
    const created = table()
    fake.script.push('We should fix the refresh token rotation first.')
    fake.script.push('That ignores the cost of a migration.')

    await runRoundtable(created.id, { ...SETTINGS, tokenCeilingPerRavel: 0 })

    const done = getRoundtable(created.id) as RoundtableConfig
    expect(done.turns.map((turn) => turn.seatId)).toEqual(['seat-1', 'seat-2', 'seat-1', 'seat-2', 'seat-1', 'seat-2'])

    // The first seat opens with no transcript; the second must see the first.
    expect(fake.prompts[0]).toContain('You speak first')
    expect(fake.prompts[0]).not.toContain('We should fix the refresh token rotation')
    expect(fake.prompts[1]).toContain('We should fix the refresh token rotation first.')
    expect(fake.prompts[1]).toContain('You are GPT')
    expect(fake.prompts[1]).toContain('Attack the plan for risk and hidden cost.')
    // A seat is never handed another seat's stance as if it were its own.
    expect(fake.prompts[1]).not.toContain('YOUR STANCE: Argue for the smallest change')
  })

  test('the table stops at its turn cap and says it never converged', async () => {
    const fake = harness()
    const created = table({ maxTurns: 3 })
    void fake

    await runRoundtable(created.id, SETTINGS)

    const done = getRoundtable(created.id) as RoundtableConfig
    expect(done.turns).toHaveLength(3)
    expect(done.conclusion).toBeNull()
    expect(done.status).toBe('concluded')
    expect(done.error).toContain('without agreeing')
  })

  test('a concluding turn ends the table early and keeps the strategy', async () => {
    const fake = harness()
    const created = table({ maxTurns: 8 })
    fake.script.push('Rotate the token.')
    fake.script.push('Agreed, and cap the retry loop.\n\nCONCLUSION: Rotate the refresh token, then cap retries at 3.')

    await runRoundtable(created.id, SETTINGS)

    const done = getRoundtable(created.id) as RoundtableConfig
    expect(done.turns).toHaveLength(2)
    expect(done.status).toBe('concluded')
    expect(done.conclusion).toBe('Rotate the refresh token, then cap retries at 3.')
  })

  test('the token ceiling stops a table that is talking itself into the ground', async () => {
    const fake = harness()
    const created = table({ maxTurns: 20 })
    for (let i = 0; i < 20; i += 1) fake.script.push('x'.repeat(4_000))

    await runRoundtable(created.id, { ...SETTINGS, tokenCeilingPerRavel: 2_000 })

    const done = getRoundtable(created.id) as RoundtableConfig
    expect(done.status).toBe('paused')
    expect(done.error).toContain('token ceiling')
    expect(done.turns.length).toBeLessThan(20)
    expect(done.usage.inputTokens + done.usage.outputTokens).toBeGreaterThan(0)
  })

  test("an operator note joins the transcript and every seat after it sees it", async () => {
    const fake = harness()
    const created = table({ maxTurns: 2 })
    const noted = addNote(created.id, 'Remember we ship on Friday.')
    expect(noted.ok).toBe(true)

    await runRoundtable(created.id, SETTINGS)

    expect(fake.prompts[0]).toContain('THE OPERATOR:\nRemember we ship on Friday.')
    const done = getRoundtable(created.id) as RoundtableConfig
    // The note is a turn in the record but never counts against the seats' cap.
    expect(done.turns.filter((turn) => turn.seatId === null)).toHaveLength(1)
    expect(done.turns.filter((turn) => turn.seatId !== null)).toHaveLength(2)
  })

  test('a seat that cannot be invoked fails the table instead of silently ending it', async () => {
    const fake = harness()
    const created = table()
    fake.respond = () => {
      throw new Error('claude headless turn exited 1')
    }

    await runRoundtable(created.id, SETTINGS)

    const done = getRoundtable(created.id) as RoundtableConfig
    expect(done.status).toBe('error')
    expect(done.error).toContain('Opus could not speak')
    expect(done.turns).toHaveLength(0)
  })

  test('a table refuses to seat one model, and refuses a question it was not given', () => {
    harness()
    const alone = createRoundtable(
      {
        name: 'Solo',
        repoId: 'repo-1',
        repoPath: 'C:/repo',
        topic: 'Anything',
        seats: [{ name: 'Opus', harness: 'claude', model: null, stance: '' }]
      }
    )
    expect(alone).toMatchObject({ ok: false, error: { code: 'seat-count' } })

    const silent = createRoundtable(
      {
        name: 'Quiet',
        repoId: 'repo-1',
        repoPath: 'C:/repo',
        topic: '   ',
        seats: [
          { name: 'A', harness: 'claude', model: null, stance: '' },
          { name: 'B', harness: 'codex', model: null, stance: '' }
        ]
      }
    )
    expect(silent).toMatchObject({ ok: false, error: { code: 'topic-required' } })
  })

  test('pausing mid-argument stops the table where it stands, and deleting takes it away', async () => {
    const fake = harness()
    const created = table({ maxTurns: 8 })
    let release: ((body: string) => void) | null = null
    fake.respond = () =>
      fake.prompts.length === 1
        ? 'First.'
        : new Promise<string>((resolve) => {
            release = resolve
          })

    const run = runRoundtable(created.id, SETTINGS)
    await settle()
    expect(fake.prompts.length).toBe(2)

    pauseRoundtable(created.id)
    ;(release as ((body: string) => void) | null)?.('Second, but too late.')
    await run

    const done = getRoundtable(created.id) as RoundtableConfig
    expect(done.status).toBe('paused')
    // The turn that was in flight when the operator pulled the handle is not
    // recorded: it was never seen, and billing for it would be a lie.
    expect(done.turns).toHaveLength(1)
    expect(fake.prompts.length).toBe(2)

    deleteRoundtable(created.id)
    expect(getRoundtable(created.id)).toBeUndefined()
  })

  test('a concluded table will not be run again on top of its own conclusion', async () => {
    const fake = harness()
    const created = table({ maxTurns: 4 })
    fake.script.push('CONCLUSION: Ship the smallest fix.')
    await runRoundtable(created.id, SETTINGS)

    const again = await runRoundtable(created.id, SETTINGS)
    expect(again).toMatchObject({ ok: false, error: { code: 'already-concluded' } })
    expect((getRoundtable(created.id) as RoundtableConfig).conclusion).toBe('Ship the smallest fix.')
  })
})
