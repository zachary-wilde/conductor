import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type * as NodeFs from 'node:fs'
import type { ConductorStore, StoreShapeV2 } from './store'
import type { RavelConfig, RavelDispatchRecord } from '@shared/types'

interface LegacyArgusConfig {
  id: string
  name: string
  repoId: string
  repoPath: string
  harness: RavelConfig['harness']
  mission: string
  maxChildren: number
  pulseSeconds: number
  allowRisky: boolean
  status: string
  managerSessionId: string | null
  createdAt: number
}

const tempDirs: string[] = []
const NOW = 1_700_000_000_000

function tempStoreFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conductor-store-'))
  tempDirs.push(dir)
  return join(dir, 'store.json')
}

afterEach(async () => {
  vi.resetModules()
  vi.doUnmock('electron')
  vi.doUnmock('node:fs')
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

// Dynamic import is the behavior under test: importing store.ts must not resolve Electron userData.
async function importStore() {
  vi.doUnmock('node:fs')
  vi.doMock('electron', () => ({
    app: {
      getPath: () => {
        throw new Error('default Electron userData path must not be resolved in store tests')
      }
    }
  }))
  return import('./store')
}

function readStoreFile(path: string): StoreShapeV2 {
  return JSON.parse(readFileSync(path, 'utf8')) as StoreShapeV2
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8')
}

function dispatch(overrides: Partial<RavelDispatchRecord> = {}): RavelDispatchRecord {
  return {
    briefId: 'brief-1',
    planRevision: 1,
    sessionId: 'session-1',
    branch: 'ravel/brief-1',
    worktreePath: 'D:/repo/.worktrees/brief-1',
    status: 'active',
    startedAt: NOW,
    endedAt: null,
    baseCommit: 'a'.repeat(40),
    usage: { inputTokens: 0, outputTokens: 0, costUsd: null },
    report: null,
    contextRequests: 0,
    verification: null,
    ...overrides
  }
}

function ravel(overrides: Partial<RavelConfig> = {}): RavelConfig {
  return {
    id: 'ravel-1',
    name: 'Ravel',
    model: null,
    repoId: 'repo-1',
    repoPath: 'D:/repo',
    harness: 'claude',
    maxChildren: 2,
    allowRisky: false,
    status: 'running',
    activity: 'thinking',
    managerSessionId: 'manager-1',
    messages: [{ id: 'msg-1', author: 'user', body: 'ship it', createdAt: NOW, delivery: 'delivered' }],
    plan: {
      revision: 1,
      createdAt: NOW,
      sourceMessageIds: ['msg-1'],
      orientation: 'Shipping the thing.',
      mission: { goal: 'ship', context: [], constraints: [], acceptanceCriteria: [], assumptions: [] },
      briefs: [],
      approvedAt: NOW,
      approvedRevision: 1
    },
    dispatches: [],
    createdAt: NOW,
    error: null,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: null },
    ...overrides
  }
}

function legacyArgus(overrides: Partial<LegacyArgusConfig> = {}): LegacyArgusConfig {
  return {
    id: 'argus-1',
    name: 'Legacy Argus',
    repoId: 'repo-1',
    repoPath: 'D:/repo',
    harness: 'codex',
    mission: 'Keep this exact mission:\n- ship safely',
    maxChildren: 4,
    pulseSeconds: 30,
    allowRisky: true,
    status: 'watching',
    managerSessionId: 'legacy-manager',
    createdAt: NOW,
    ...overrides
  }
}

function seededShape(overrides: Partial<StoreShapeV2> = {}): StoreShapeV2 {
  return {
    schemaVersion: 2,
    repos: [{ id: 'repo-1', path: 'D:/Repo', name: 'Repo', addedAt: NOW }],
    settings: {
      defaultHarness: 'claude',
      theme: 'flat',
      acrylic: true,
      acrylicIntensity: 71,
      panels: {},
      panelOrder: [],
      panelDock: {},
      panelSizes: {},
      harnessPaths: {},
      harnessModels: { zai: 'zai/glm-5.2' },
      harnessArgs: {},
      harnessFallback: ['claude', 'codex', 'zai'],
      hooks: { global: null, perRepo: {} },
      verify: { global: null, perRepo: {} },
      autostart: false,
      shellHooksConsented: false,
      worktreeRoot: null,
      tokenCeilingPerRavel: 0,
      editor: {
        fontFamily: 'Mono',
        fontSize: 13,
        wordWrap: true,
        minimap: false,
        gotoDefinition: true
      },
      canvas: { panels: [], layouts: [], activeLayoutId: null, defaultLayoutVersion: 0 }
    },
    worktrees: {
      'D:/Repo/.worktrees/one': {
        repoId: 'repo-1',
        repoPath: 'D:/Repo',
        branch: 'one',
        createdAt: NOW
      }
    },
    ravel: [ravel({ id: 'ravel-1', name: 'Original Ravel' })],
    ...overrides
  }
}

function storeSnapshot(store: ConductorStore): StoreShapeV2 {
  return {
    schemaVersion: 2,
    repos: store.getRepos(),
    settings: store.getSettings(),
    worktrees: store.getWorktrees(),
    ravel: store.getRavel()
  }
}

async function importStoreWithControllableRename() {
  const actualFs = await vi.importActual<typeof NodeFs>('node:fs')
  let failWrites = false
  vi.doMock('electron', () => ({
    app: {
      getPath: () => {
        throw new Error('default Electron userData path must not be resolved in store tests')
      }
    }
  }))
  vi.doMock('node:fs', () => ({
    ...actualFs,
    renameSync: (from: string, to: string) => {
      if (failWrites) throw new Error('simulated persist failure')
      return actualFs.renameSync(from, to)
    }
  }))
  const mod = await import('./store')
  return {
    createStoreForPath: mod.createStoreForPath,
    failWrites: () => {
      failWrites = true
    },
    allowWrites: () => {
      failWrites = false
    }
  }
}

async function expectInvalidStorePreserved(original: unknown): Promise<void> {
  const { createStoreForPath } = await importStore()
  const file = tempStoreFile()
  const raw = JSON.stringify(original, null, 2)
  writeFileSync(file, raw, 'utf8')
  const store = createStoreForPath(file)

  expect(() => store.init()).toThrow(/^failed to load store: /)
  expect(readFileSync(file, 'utf8')).toBe(raw)
  expect(store.getLoadError()).toBeInstanceOf(Error)
}

describe('createStoreForPath', () => {
  test('initializes a missing file as schema v2 with empty ravel and persists updates', async () => {
    const { createStoreForPath } = await importStore()
    const file = tempStoreFile()
    const store = createStoreForPath(file)

    store.init()

    expect(store.getLoadError()).toBeNull()
    expect(store.getRavel()).toEqual([])
    expect(readJson(file)).toMatchObject({ schemaVersion: 2, repos: [], worktrees: {}, ravel: [] })

    const cfg = ravel()
    store.addRavel(cfg)

    expect(readStoreFile(file).ravel).toEqual([cfg])
  })

  test('loads schema v2 records and interrupts live dispatches for restart', async () => {
    const { createStoreForPath } = await importStore()
    const file = tempStoreFile()
    const stored = ravel({
      status: 'running',
      managerSessionId: 'manager-1',
      dispatches: [
        dispatch({ briefId: 'starting', status: 'starting' }),
        dispatch({ briefId: 'active', status: 'active' }),
        dispatch({ briefId: 'completed', status: 'completed' }),
        dispatch({ briefId: 'failed', status: 'failed' })
      ]
    })
    writeJson(file, { schemaVersion: 2, repos: [{ id: 'repo-1', path: 'D:/repo', name: 'repo', addedAt: NOW }], settings: { defaultHarness: 'codex' }, worktrees: { 'D:/wt': { repoId: 'repo-1', repoPath: 'D:/repo', branch: 'x', createdAt: NOW } }, ravel: [stored] })

    const store = createStoreForPath(file)
    store.init()

    expect(store.getRepos()).toHaveLength(1)
    expect(store.getSettings().defaultHarness).toBe('codex')
    expect(store.getWorktrees()).toHaveProperty('D:/wt')
    expect(store.getRavel()[0]).toMatchObject({ id: stored.id, name: stored.name, status: 'paused', managerSessionId: null })
    expect(store.getRavel()[0].dispatches.map((item) => [item.briefId, item.status])).toEqual([
      ['starting', 'interrupted'],
      ['active', 'interrupted'],
      ['completed', 'completed'],
      ['failed', 'failed']
    ])
  })
  test('loads legacy v2 ravels with capSecret and drops it from memory and rewrites', async () => {
    const { createStoreForPath } = await importStore()
    const file = tempStoreFile()
    const legacy = { ...ravel(), capSecret: 'legacy-secret' }
    writeJson(file, {
      schemaVersion: 2,
      repos: [],
      settings: {},
      worktrees: {},
      ravel: [legacy]
    })

    const store = createStoreForPath(file)
    store.init()

    const loaded = store.getRavel()[0]
    expect(loaded).not.toHaveProperty('capSecret')
    store.replaceRavel(loaded.id, loaded)
    expect(readJson(file)).toMatchObject({ ravel: [{ id: loaded.id }] })
    const persisted = readJson(file)
    expect(persisted).not.toHaveProperty('ravel[0].capSecret')
  })


  test('migrates legacy argus records into ravel records with delivered migration messages', async () => {
    const { createStoreForPath } = await importStore()
    const file = tempStoreFile()
    const withMission = legacyArgus()
    const withoutMission = legacyArgus({ id: 'argus-empty', mission: '' })
    writeJson(file, { repos: [], settings: {}, worktrees: {}, argus: [withMission, withoutMission] })

    const store = createStoreForPath(file)
    store.init()

    const migrated = store.getRavel()
    expect(migrated).toHaveLength(2)
    expect(migrated[0]).toMatchObject({
      id: withMission.id,
      name: withMission.name,
      repoId: withMission.repoId,
      repoPath: withMission.repoPath,
      harness: withMission.harness,
      maxChildren: withMission.maxChildren,
      allowRisky: withMission.allowRisky,
      status: 'paused',
      activity: 'idle',
      managerSessionId: null,
      plan: null,
      dispatches: [],
      createdAt: withMission.createdAt,
      error: null
    })
    // The pulse interval died with the persistent manager; a legacy record that
    // still carries one must not resurrect it.
    expect('pulseSeconds' in migrated[0]).toBe(false)
    expect(migrated[0].messages).toHaveLength(2)
    expect(migrated[0].messages[0]).toMatchObject({ author: 'system', delivery: 'delivered' })
    expect(migrated[0].messages[1]).toMatchObject({ author: 'user', body: withMission.mission, delivery: 'delivered' })
    expect(migrated[1].messages).toHaveLength(1)
    expect(migrated[1].messages[0]).toMatchObject({ author: 'system', delivery: 'delivered' })
    expect(migrated[1].messages.some((message) => message.author === 'user')).toBe(false)
  })

  test('migrates the old acrylic theme into palette plus translucency flag', async () => {
    const { createStoreForPath } = await importStore()
    const file = tempStoreFile()
    writeJson(file, { schemaVersion: 2, repos: [], settings: { theme: 'acrylic' }, worktrees: {}, ravel: [] })
    const store = createStoreForPath(file)
    store.init()
    expect(store.getSettings()).toMatchObject({ theme: 'flat', acrylic: true })
  })

  test('stores acrylic intensity and defaults it for older stores', async () => {
    const { createStoreForPath } = await importStore()
    const file = tempStoreFile()
    writeJson(file, { schemaVersion: 2, repos: [], settings: { acrylic: true }, worktrees: {}, ravel: [] })
    const store = createStoreForPath(file)
    store.init()
    expect(store.getSettings().acrylicIntensity).toBe(71)
    expect(store.saveSettings({ acrylicIntensity: 90 }).acrylicIntensity).toBe(90)
    expect(store.saveSettings({ acrylicIntensity: 0 }).acrylicIntensity).toBe(0)
  })

  test('defaults an old canvas to layout version zero without changing geometry', async () => {
    const { createStoreForPath } = await importStore()
    const file = tempStoreFile()
    const shape = seededShape()
    const existing = {
      id: 'sessions',
      kind: 'sessions',
      subjectId: null,
      x: 81,
      y: 39,
      w: 300,
      h: 280,
      z: 1,
      minimized: false
    }
    shape.settings.canvas = { panels: [existing], layouts: [], activeLayoutId: null } as never
    writeJson(file, shape)

    const store = createStoreForPath(file)
    store.init()

    expect(store.getSettings().canvas).toEqual({
      panels: [existing],
      layouts: [],
      activeLayoutId: null,
      defaultLayoutVersion: 0
    })
  })

  test('preserves a valid canvas layout version', async () => {
    const { createStoreForPath } = await importStore()
    const file = tempStoreFile()
    const shape = seededShape()
    shape.settings.canvas.defaultLayoutVersion = 1
    writeJson(file, shape)

    const store = createStoreForPath(file)
    store.init()

    expect(store.getSettings().canvas.defaultLayoutVersion).toBe(1)
  })

  test('a pre-mascot store gains an empty insight state instead of failing to load', async () => {
    const { createStoreForPath } = await importStore()
    const file = tempStoreFile()
    writeJson(file, { schemaVersion: 2, repos: [], settings: {}, worktrees: {}, ravel: [] })
    const store = createStoreForPath(file)
    store.init()
    expect(store.getInsightState()).toEqual({
      current: null,
      lastGlobalShownAt: 0,
      lastShownByRule: {},
      seen: []
    })
  })

  test('insight state survives a reload, so the mascot cannot repeat itself', async () => {
    const { createStoreForPath } = await importStore()
    const file = tempStoreFile()
    const store = createStoreForPath(file)
    store.init()
    const insight = {
      ruleId: 'scope.do-not-touch',
      category: 'scope' as const,
      severity: 'critical' as const,
      message: 'brief-1 touched src/billing',
      dedupeKey: 'brief-1:src/billing',
      shownAt: 1_720_000_000_000
    }
    store.saveInsightState({
      current: insight,
      lastGlobalShownAt: insight.shownAt,
      lastShownByRule: { 'scope.do-not-touch': insight.shownAt },
      seen: [{ dedupeKey: insight.dedupeKey, shownAt: insight.shownAt }]
    })

    const reloaded = createStoreForPath(file)
    reloaded.init()
    expect(reloaded.getInsightState().current).toEqual(insight)
    expect(reloaded.getInsightState().seen).toEqual([
      { dedupeKey: insight.dedupeKey, shownAt: insight.shownAt }
    ])
  })

  test('the seen ring is trimmed on load, not just on write', async () => {
    const { createStoreForPath } = await importStore()
    const file = tempStoreFile()
    const seen = Array.from({ length: 250 }, (_, i) => ({ dedupeKey: `k${i}`, shownAt: i }))
    writeJson(file, {
      schemaVersion: 2,
      repos: [],
      settings: {},
      worktrees: {},
      ravel: [],
      insights: { current: null, lastGlobalShownAt: 0, lastShownByRule: {}, seen }
    })
    const store = createStoreForPath(file)
    store.init()
    const loaded = store.getInsightState().seen
    expect(loaded).toHaveLength(200)
    // Trimmed from the front: the newest observations are the ones worth keeping.
    expect(loaded[loaded.length - 1].dedupeKey).toBe('k249')
  })

  test.each([
    ['a non-object', { insights: 7 }],
    ['a missing cooldown clock', { insights: { current: null, lastShownByRule: {}, seen: [] } }],
    ['a non-numeric rule timestamp', { insights: { current: null, lastGlobalShownAt: 0, lastShownByRule: { a: 'soon' }, seen: [] } }],
    ['an unknown category', { insights: { current: { ruleId: 'r', category: 'vibes', severity: 'info', message: 'm', dedupeKey: 'd', shownAt: 1 }, lastGlobalShownAt: 0, lastShownByRule: {}, seen: [] } }],
    ['an unknown severity', { insights: { current: { ruleId: 'r', category: 'cost', severity: 'apocalyptic', message: 'm', dedupeKey: 'd', shownAt: 1 }, lastGlobalShownAt: 0, lastShownByRule: {}, seen: [] } }],
    ['a malformed seen entry', { insights: { current: null, lastGlobalShownAt: 0, lastShownByRule: {}, seen: [{ dedupeKey: 'd' }] } }]
  ])('refuses to load a store with %s rather than silently resetting', async (_label, patch) => {
    const { createStoreForPath } = await importStore()
    const file = tempStoreFile()
    writeJson(file, { schemaVersion: 2, repos: [], settings: {}, worktrees: {}, ravel: [], ...patch })
    const store = createStoreForPath(file)
    expect(() => store.init()).toThrow(/^failed to load store: /)
    expect(store.getLoadError()).toBeInstanceOf(Error)
  })

  test('stores the token ceiling and defaults it for older stores', async () => {
    const { createStoreForPath } = await importStore()
    const file = tempStoreFile()
    writeJson(file, { schemaVersion: 2, repos: [], settings: { acrylic: true }, worktrees: {}, ravel: [] })
    const store = createStoreForPath(file)
    store.init()
    expect(store.getSettings().tokenCeilingPerRavel).toBe(0)
    expect(store.saveSettings({ tokenCeilingPerRavel: 50_000 }).tokenCeilingPerRavel).toBe(50_000)
    // Survives a round trip: a field missing from the save literal is erased.
    expect(store.saveSettings({ acrylic: false }).tokenCeilingPerRavel).toBe(50_000)
  })

  test('defaults autostart to off and persists it once enabled', async () => {
    const { createStoreForPath } = await importStore()
    const file = tempStoreFile()
    writeJson(file, { schemaVersion: 2, repos: [], settings: { acrylic: true }, worktrees: {}, ravel: [] })
    const store = createStoreForPath(file)
    store.init()
    expect(store.getSettings().autostart).toBe(false)
    expect(store.saveSettings({ autostart: true }).autostart).toBe(true)
    // Survives a round trip: a field missing from the save literal is preserved.
    expect(store.saveSettings({ acrylic: false }).autostart).toBe(true)
  })

  test('defaults shell-execution consent to off and persists it once granted', async () => {
    const { createStoreForPath } = await importStore()
    const file = tempStoreFile()
    writeJson(file, { schemaVersion: 2, repos: [], settings: { acrylic: true }, worktrees: {}, ravel: [] })
    const store = createStoreForPath(file)
    store.init()
    // Older stores (and fresh installs) are unconsented by default — fail-closed.
    expect(store.getSettings().shellHooksConsented).toBe(false)
    expect(store.saveSettings({ shellHooksConsented: true }).shellHooksConsented).toBe(true)
    // Survives a round trip: a field missing from the save literal is preserved.
    expect(store.saveSettings({ acrylic: false }).shellHooksConsented).toBe(true)
  })

  test('defaults usage and report on v2 ravels written before metering existed', async () => {
    const { createStoreForPath } = await importStore()
    const file = tempStoreFile()
    const stored = ravel({
      status: 'paused',
      dispatches: [dispatch({ status: 'completed' })]
    }) as unknown as Record<string, unknown>
    delete stored.usage
    delete (stored.dispatches as Array<Record<string, unknown>>)[0].usage
    delete (stored.dispatches as Array<Record<string, unknown>>)[0].report
    writeJson(file, { schemaVersion: 2, repos: [], settings: {}, worktrees: {}, ravel: [stored] })

    const store = createStoreForPath(file)
    store.init()

    expect(store.getRavel()[0].usage).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: null })
    expect(store.getRavel()[0].dispatches[0].usage).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: null })
    expect(store.getRavel()[0].dispatches[0].report).toBeNull()
  })

  test('persists hidden panels and ignores unknown panel ids', async () => {
    const { createStoreForPath } = await importStore()
    const file = tempStoreFile()
    writeJson(file, { schemaVersion: 2, repos: [], settings: { panels: { log: false, bogus: true } }, worktrees: {}, ravel: [] })
    const store = createStoreForPath(file)
    store.init()
    expect(store.getSettings().panels).toEqual({ log: false })
    expect(store.saveSettings({ panels: { log: false, fleet: false } }).panels).toEqual({ log: false, fleet: false })
  })

  test('defaults the panel order for older stores and drops unknown or repeated ids', async () => {
    const { createStoreForPath } = await importStore()
    const file = tempStoreFile()
    writeJson(file, { schemaVersion: 2, repos: [], settings: { panels: {} }, worktrees: {}, ravel: [] })
    const store = createStoreForPath(file)
    store.init()
    expect(store.getSettings().panelOrder).toEqual([])
    expect(store.saveSettings({ panelOrder: ['log', 'plan'] }).panelOrder).toEqual(['log', 'plan'])
    // Survives a round trip: a field missing from the save literal is erased.
    expect(store.saveSettings({ acrylic: false }).panelOrder).toEqual(['log', 'plan'])
  })

  test('ignores unknown and repeated ids in a stored panel order', async () => {
    const { createStoreForPath } = await importStore()
    const file = tempStoreFile()
    writeJson(file, {
      schemaVersion: 2,
      repos: [],
      settings: { panelOrder: ['fleet', 'bogus', 'fleet', 'plan'] },
      worktrees: {},
      ravel: []
    })
    const store = createStoreForPath(file)
    store.init()
    expect(store.getSettings().panelOrder).toEqual(['fleet', 'plan'])
  })

  test('remembers which rail a panel was dragged to, and defaults the rest to the right', async () => {
    const { createStoreForPath } = await importStore()
    const file = tempStoreFile()
    writeJson(file, { schemaVersion: 2, repos: [], settings: {}, worktrees: {}, ravel: [] })
    const store = createStoreForPath(file)
    store.init()
    expect(store.getSettings().panelDock).toEqual({})
    expect(store.saveSettings({ panelDock: { manager: 'left' } }).panelDock).toEqual({ manager: 'left' })
    expect(store.saveSettings({ acrylic: false }).panelDock).toEqual({ manager: 'left' })
    expect(store.saveSettings({ panelDock: {} }).panelDock).toEqual({})
  })

  test('drops a dock entry a newer build wrote rather than refusing the whole store', async () => {
    const { createStoreForPath } = await importStore()
    const file = tempStoreFile()
    writeJson(file, {
      schemaVersion: 2,
      repos: [],
      // 'projects' is a shell rail, not a dockable panel; 'bottom' is a zone
      // this build does not have. Both must be ignored, not rejected — a
      // rejected store locks the operator out of saving anything at all.
      settings: { panelDock: { fleet: 'left', projects: 'left', log: 'bottom' } },
      worktrees: {},
      ravel: []
    })
    const store = createStoreForPath(file)
    store.init()
    expect(store.getSettings().panelDock).toEqual({ fleet: 'left' })
    expect(store.saveSettings({ acrylic: true }).acrylic).toBe(true)
  })

  test('keeps palette and translucency independent', async () => {
    const { createStoreForPath } = await importStore()
    const file = tempStoreFile()
    writeJson(file, { schemaVersion: 2, repos: [], settings: { theme: 'terminal', acrylic: false }, worktrees: {}, ravel: [] })
    const store = createStoreForPath(file)
    store.init()
    expect(store.getSettings()).toMatchObject({ theme: 'terminal', acrylic: false })
    expect(store.saveSettings({ acrylic: true })).toMatchObject({ theme: 'terminal', acrylic: true })
  })

  test('keeps roundtables across a reopen and defaults them empty for older stores', async () => {
    const { createStoreForPath } = await importStore()
    const file = tempStoreFile()
    writeJson(file, { schemaVersion: 2, repos: [], settings: {}, worktrees: {}, ravel: [] })
    const store = createStoreForPath(file)
    store.init()
    expect(store.listRoundtables()).toEqual([])

    const saved = store.addRoundtable({
      id: 'table-1',
      name: 'Strategy',
      repoId: 'repo-1',
      repoPath: 'D:/repo',
      topic: 'What next?',
      seats: [
        { id: 'seat-1', name: 'Opus', harness: 'claude', model: 'opus', stance: 'simplest thing' },
        { id: 'seat-2', name: 'GPT', harness: 'codex', model: null, stance: '' }
      ],
      turns: [
        { id: 'turn-1', seatId: 'seat-1', body: 'Rotate the token.', createdAt: NOW, usage: { inputTokens: 10, outputTokens: 4, costUsd: null } },
        { id: 'turn-2', seatId: null, body: 'We ship Friday.', createdAt: NOW, usage: { inputTokens: 0, outputTokens: 0, costUsd: null } }
      ],
      maxTurns: 6,
      status: 'running',
      conclusion: null,
      error: null,
      usage: { inputTokens: 10, outputTokens: 4, costUsd: null },
      createdAt: NOW
    })
    expect(saved.turns).toHaveLength(2)

    const reopened = createStoreForPath(file)
    reopened.init()
    const loaded = reopened.getRoundtable('table-1')
    // A table cannot still be talking after a restart — the process that was
    // running its turns is gone — but nothing it said may be lost.
    expect(loaded?.status).toBe('paused')
    expect(loaded?.turns.map((turn) => turn.body)).toEqual(['Rotate the token.', 'We ship Friday.'])
    expect(loaded?.seats[1]).toMatchObject({ harness: 'codex', model: null })
  })

  test('a corrupt roundtable is rejected on load rather than half-read', async () => {
    const { createStoreForPath } = await importStore()
    const file = tempStoreFile()
    writeJson(file, {
      schemaVersion: 2,
      repos: [],
      settings: {},
      worktrees: {},
      ravel: [],
      roundtables: [{ id: 'table-1', name: 'Bad', repoId: 'r', repoPath: 'D:/r', topic: 't', seats: [{ id: 's', name: 'n', harness: 'nope', model: null, stance: '' }], turns: [], maxTurns: 4, status: 'idle', conclusion: null, error: null, usage: null, createdAt: NOW }]
    })
    const store = createStoreForPath(file)
    // Same contract as every other corrupt record: refuse the load loudly and
    // leave the file alone, rather than dropping the table and writing back a
    // store the operator did not ask for.
    expect(() => store.init()).toThrow(/invalid roundtable seat/)
    expect(store.getLoadError()).toBeInstanceOf(Error)
  })

  test('defaults the theme for stores written before themes existed and keeps a valid choice', async () => {
    const { createStoreForPath } = await importStore()
    const legacyFile = tempStoreFile()
    writeJson(legacyFile, { schemaVersion: 2, repos: [], settings: { defaultHarness: 'codex' }, worktrees: {}, ravel: [] })
    const legacyStore = createStoreForPath(legacyFile)
    legacyStore.init()
    expect(legacyStore.getSettings().theme).toBe('flat')

    const chosenFile = tempStoreFile()
    writeJson(chosenFile, { schemaVersion: 2, repos: [], settings: { theme: 'terminal' }, worktrees: {}, ravel: [] })
    const chosenStore = createStoreForPath(chosenFile)
    chosenStore.init()
    expect(chosenStore.getSettings().theme).toBe('terminal')
    expect(chosenStore.saveSettings({ theme: 'flat' }).theme).toBe('flat')
  })

  test('folds a legacy zaiModel setting into the per-harness model map', async () => {
    const { createStoreForPath } = await importStore()
    const file = tempStoreFile()
    writeJson(file, { repos: [], settings: { zaiModel: 'zai/legacy-model' }, worktrees: {}, argus: [] })

    const store = createStoreForPath(file)
    store.init()

    expect(store.getSettings().harnessModels).toEqual({ zai: 'zai/legacy-model' })
    expect(readStoreFile(file).settings).not.toHaveProperty('zaiModel')
  })

  test('keeps explicit per-harness models alongside a legacy zai model', async () => {
    const { createStoreForPath } = await importStore()
    const file = tempStoreFile()
    writeJson(file, {
      schemaVersion: 2,
      repos: [],
      settings: { zaiModel: 'zai/legacy-model', harnessModels: { claude: 'opus', zai: 'zai/explicit' } },
      worktrees: {},
      ravel: []
    })

    const store = createStoreForPath(file)
    store.init()

    expect(store.getSettings().harnessModels).toEqual({ claude: 'opus', zai: 'zai/explicit' })
  })

  test('writes a Windows-safe timestamped backup beside the store during migration', async () => {
    const { createStoreForPath } = await importStore()
    const file = tempStoreFile()
    const original = { repos: [], settings: {}, worktrees: {}, argus: [legacyArgus()] }
    writeJson(file, original)

    createStoreForPath(file).init()

    const entries = readdirSync(join(file, '..'))
    const backups = entries.filter((entry) => entry !== basename(file) && entry.startsWith('store.json.'))
    expect(backups).toHaveLength(1)
    expect(backups[0]).toMatch(/^store\.json\.backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/)
    expect(/[<>:"/\\|?*]/.test(backups[0])).toBe(false)
    expect(readJson(join(file, '..', backups[0]))).toEqual(original)
    expect(readStoreFile(file).schemaVersion).toBe(2)
    expect(readStoreFile(file)).toHaveProperty('ravel')
    expect(readStoreFile(file)).not.toHaveProperty('argus')
  })

  test('the migration backup restores byte-identical legacy data for a rollback to the previous binary', async () => {
    const { createStoreForPath } = await importStore()
    const file = tempStoreFile()
    const dir = join(file, '..')
    const worktrees = { 'D:/wt/a': { repoId: 'repo-1', repoPath: 'D:/repo', branch: 'feature/a', createdAt: 2 } }
    const originalRaw = JSON.stringify(
      { repos: [], settings: { defaultHarness: 'codex' }, worktrees, argus: [legacyArgus()] },
      null,
      2
    )
    writeFileSync(file, originalRaw, 'utf8')

    createStoreForPath(file).init()
    const backup = readdirSync(dir).find((entry) => entry.startsWith('store.json.backup-'))
    if (!backup) throw new Error('expected a migration backup')

    // Rolling back is a file copy: the operator restores the backup over store.json.
    writeFileSync(file, readFileSync(join(dir, backup), 'utf8'), 'utf8')

    const restored = readJson(file) as { argus?: unknown[]; ravel?: unknown; schemaVersion?: number; worktrees: unknown }
    expect(restored).not.toHaveProperty('ravel')
    expect(restored).not.toHaveProperty('schemaVersion')
    expect(restored.argus).toHaveLength(1)
    expect(restored.worktrees).toEqual(worktrees)
  })

  test('persists by writing a temporary file and renaming it without leaving temp files on success', async () => {
    const actualFs = await vi.importActual<typeof NodeFs>('node:fs')
    const renameCalls: Array<[string, string]> = []
    vi.doMock('node:fs', () => ({
      ...actualFs,
      renameSync: (from: string, to: string) => {
        renameCalls.push([from, to])
        return actualFs.renameSync(from, to)
      }
    }))
    const { createStoreForPath } = await import('./store')
    const file = tempStoreFile()
    const store = createStoreForPath(file)
    store.init()

    store.addRavel(ravel())

    expect(renameCalls.some(([from, to]) => to === file && from !== file && basename(from).includes('.tmp-'))).toBe(true)
    expect(readdirSync(join(file, '..')).filter((entry) => entry.includes('.tmp-'))).toEqual([])
  })

  test.each([
    ['malformed JSON', '{not json'],
    ['migration validation failure', JSON.stringify({ repos: [], settings: {}, worktrees: {}, argus: [{ id: 1 }] }, null, 2)]
  ])('%s preserves the original file, records the load error, and throws', async (_name, original) => {
    const { createStoreForPath } = await importStore()
    const file = tempStoreFile()
    writeFileSync(file, original, 'utf8')
    const store = createStoreForPath(file)

    expect(() => store.init()).toThrow(/^failed to load store: /)

    expect(readFileSync(file, 'utf8')).toBe(original)
    expect(store.getLoadError()).toBeInstanceOf(Error)
    expect(store.getRavel()).toEqual([])
  })
  test('backs up corrupt data before surfacing a load failure', async () => {
    const { createStoreForPath } = await importStore()
    const file = tempStoreFile()
    const original = '{not json'
    writeFileSync(file, original, 'utf8')

    const store = createStoreForPath(file)
    expect(() => store.init()).toThrow(/^failed to load store: /)

    const backup = readdirSync(join(file, '..')).find((entry) => entry.startsWith('store.json.backup-'))
    if (!backup) throw new Error('expected a corrupt-store backup')
    expect(readFileSync(join(file, '..', backup), 'utf8')).toBe(original)
  })

  test('resets a corrupt store and validates imports before replacing it', async () => {
    const { createStoreForPath } = await importStore()
    const file = tempStoreFile()
    const invalidImport = join(file, '..', 'invalid.json')
    const validImport = join(file, '..', 'valid.json')
    const original = '{not json'
    writeFileSync(file, original, 'utf8')
    writeFileSync(invalidImport, '{still not json', 'utf8')
    writeJson(validImport, seededShape({ repos: [{ id: 'imported', path: 'D:/imported', name: 'Imported', addedAt: NOW }] }))

    const store = createStoreForPath(file)
    expect(() => store.init()).toThrow(/^failed to load store: /)
    expect(() => store.importFrom(invalidImport)).toThrow(/^failed to load store: /)
    expect(readFileSync(file, 'utf8')).toBe(original)

    store.reset()
    expect(store.getLoadError()).toBeNull()
    expect(store.getRepos()).toEqual([])

    store.importFrom(validImport)
    expect(store.getRepos()).toEqual([{ id: 'imported', path: 'D:/imported', name: 'Imported', addedAt: NOW }])
    expect(readStoreFile(file).repos).toEqual(store.getRepos())
    const exported = join(file, '..', 'exported.json')
    store.exportTo(exported)
    expect(readFileSync(exported, 'utf8')).toBe(readFileSync(file, 'utf8'))
  })

  test('refuses every write after a failed load so an unreadable store is never overwritten', async () => {
    const { createStoreForPath } = await importStore()
    const file = tempStoreFile()
    const original = '{not json'
    writeFileSync(file, original, 'utf8')
    const store = createStoreForPath(file)

    expect(() => store.init()).toThrow(/^failed to load store: /)

    // The cache is an empty store at this point. Writing it back would replace
    // a file we could not parse with defaults and destroy recoverable data.
    expect(() => store.saveSettings({ theme: 'terminal' })).toThrow(/refusing to write/)
    expect(() => store.addRepo({ id: 'repo', name: 'Repo', path: 'D:/repo', addedAt: NOW })).toThrow(
      /refusing to write/
    )

    expect(readFileSync(file, 'utf8')).toBe(original)
  })

  test.each([
    ['message author', { ...ravel(), messages: [{ id: 'msg', author: 'agent', body: 'body', createdAt: NOW, delivery: 'delivered' }] }],
    ['message body', { ...ravel(), messages: [{ id: 'msg', author: 'user', body: 4, createdAt: NOW, delivery: 'delivered' }] }],
    ['message delivery', { ...ravel(), messages: [{ id: 'msg', author: 'user', body: 'body', createdAt: NOW, delivery: 'sent' }] }],
    ['message timestamp', { ...ravel(), messages: [{ id: 'msg', author: 'user', body: 'body', createdAt: 'now', delivery: 'delivered' }] }],
    ['plan mission arrays', { ...ravel(), plan: { ...ravel().plan, mission: { goal: 'ship', context: 'bad', constraints: [], acceptanceCriteria: [], assumptions: [] } } }],
    ['plan revision', { ...ravel(), plan: { ...ravel().plan, revision: '1' } }],
    ['plan source IDs', { ...ravel(), plan: { ...ravel().plan, sourceMessageIds: ['msg', 7] } }],
    ['plan approval timestamp', { ...ravel(), plan: { ...ravel().plan, approvedAt: 'later' } }],
    ['plan approval revision', { ...ravel(), plan: { ...ravel().plan, approvedRevision: '1' } }],
    ['brief string fields', { ...ravel(), plan: { ...ravel().plan, briefs: [{ id: 'brief', title: 42, role: 'lead-engineer', harness: 'claude', phase: 'implementation', goal: 'goal', relevantContext: [], constraints: [], acceptanceCriteria: [], doNotTouch: [], expectedOutput: 'output', escalationConditions: [], dependsOn: [], contextExceptionReason: null }] } }],
    ['brief role', { ...ravel(), plan: { ...ravel().plan, briefs: [{ id: 'brief', title: 'Brief', role: 'manager', harness: 'claude', phase: 'implementation', goal: 'goal', relevantContext: [], constraints: [], acceptanceCriteria: [], doNotTouch: [], expectedOutput: 'output', escalationConditions: [], dependsOn: [], contextExceptionReason: null }] } }],
    ['brief harness', { ...ravel(), plan: { ...ravel().plan, briefs: [{ id: 'brief', title: 'Brief', role: 'lead-engineer', harness: 'bad', phase: 'implementation', goal: 'goal', relevantContext: [], constraints: [], acceptanceCriteria: [], doNotTouch: [], expectedOutput: 'output', escalationConditions: [], dependsOn: [], contextExceptionReason: null }] } }],
    ['brief phase', { ...ravel(), plan: { ...ravel().plan, briefs: [{ id: 'brief', title: 'Brief', role: 'lead-engineer', harness: 'claude', phase: 'done', goal: 'goal', relevantContext: [], constraints: [], acceptanceCriteria: [], doNotTouch: [], expectedOutput: 'output', escalationConditions: [], dependsOn: [], contextExceptionReason: null }] } }],
    ['brief arrays', { ...ravel(), plan: { ...ravel().plan, briefs: [{ id: 'brief', title: 'Brief', role: 'lead-engineer', harness: 'claude', phase: 'implementation', goal: 'goal', relevantContext: [3], constraints: [], acceptanceCriteria: [], doNotTouch: [], expectedOutput: 'output', escalationConditions: [], dependsOn: [], contextExceptionReason: null }] } }],
    ['brief context exception', { ...ravel(), plan: { ...ravel().plan, briefs: [{ id: 'brief', title: 'Brief', role: 'lead-engineer', harness: 'claude', phase: 'implementation', goal: 'goal', relevantContext: [], constraints: [], acceptanceCriteria: [], doNotTouch: [], expectedOutput: 'output', escalationConditions: [], dependsOn: [], contextExceptionReason: 1 }] } }],
    ['dispatch fields', { ...ravel(), dispatches: [{ ...dispatch(), branch: 9 }] }],
    ['dispatch status', { ...ravel(), dispatches: [dispatch({ status: 'active' }), { ...dispatch(), status: 'queued' }] }],
    ['dispatch session', { ...ravel(), dispatches: [{ ...dispatch(), sessionId: 7 }] }],
    ['dispatch timestamp', { ...ravel(), dispatches: [{ ...dispatch(), startedAt: 'now' }] }]
  ])('malformed nested ravel %s preserves the original file, records the load error, and throws', async (_name, invalidRavel) => {
    await expectInvalidStorePreserved({ schemaVersion: 2, repos: [], settings: {}, worktrees: {}, ravel: [invalidRavel] })
  })

  test.each([
    ['default harness', { defaultHarness: 'bad' }],
    ['harness path values', { harnessPaths: { claude: 7 } }],
    ['zai model', { zaiModel: 4 }],
    ['theme', { theme: 'neon' }],
    ['acrylic flag', { acrylic: 'yes' }],
    ['acrylic intensity type', { acrylicIntensity: 'high' }],
    ['acrylic intensity range', { acrylicIntensity: 140 }],
    ['panel visibility values', { panels: { plan: 'no' } }],
    ['panel size values', { panelSizes: { projects: 'wide' } }],
    ['panel order shape', { panelOrder: 'log' }],
    ['panel order entries', { panelOrder: ['log', 7] }],
    ['harness arg arrays', { harnessArgs: { codex: ['--ok', 5] } }],
    ['hooks global', { hooks: { global: 8 } }],
    ['hooks perRepo map', { hooks: { perRepo: { repo: 9 } } }],
    ['worktree root', { worktreeRoot: 12 }],
    ['editor field types', { editor: { fontSize: 'large' } }]
  ])('malformed settings %s preserves the original file, records the load error, and throws', async (_name, settings) => {
    await expectInvalidStorePreserved({ schemaVersion: 2, repos: [], settings, worktrees: {}, ravel: [] })
  })

  test('persist failure during migration preserves the original file, records the load error, and throws', async () => {
    const actualFs = await vi.importActual<typeof NodeFs>('node:fs')
    vi.doMock('node:fs', () => ({
      ...actualFs,
      renameSync: (from: string, to: string) => {
        if (to.endsWith('store.json')) throw new Error('simulated rename failure')
        return actualFs.renameSync(from, to)
      }
    }))
    const { createStoreForPath } = await import('./store')
    const file = tempStoreFile()
    const original = JSON.stringify({ repos: [], settings: {}, worktrees: {}, argus: [legacyArgus()] }, null, 2)
    writeFileSync(file, original, 'utf8')
    const store = createStoreForPath(file)

    expect(() => store.init()).toThrow(/^failed to load store: simulated rename failure/)

    expect(readFileSync(file, 'utf8')).toBe(original)
    expect(store.getLoadError()).toBeInstanceOf(Error)
    expect(readdirSync(join(file, '..')).filter((entry) => entry.includes('.tmp-'))).toEqual([])
  })

  test('factory instances are isolated and import does not resolve the default Electron path', async () => {
    const { createStoreForPath, store: defaultStore } = await importStore()
    const firstFile = tempStoreFile()
    const secondFile = tempStoreFile()
    const first = createStoreForPath(firstFile)
    const second = createStoreForPath(() => secondFile)

    first.init()
    second.init()
    first.addRavel(ravel({ id: 'first' }))
    second.addRavel(ravel({ id: 'second' }))

    expect(first.getRavel().map((item) => item.id)).toEqual(['first'])
    expect(second.getRavel().map((item) => item.id)).toEqual(['second'])
    expect(readStoreFile(firstFile).ravel[0].id).toBe('first')
    expect(readStoreFile(secondFile).ravel[0].id).toBe('second')
    expect(defaultStore.getLoadError()).toBeNull()
  })

  test('updateRavel persists patches and replaceRavel persists the full replacement object', async () => {
    const { createStoreForPath } = await importStore()
    const file = tempStoreFile()
    const store = createStoreForPath(file)
    store.init()
    store.addRavel(ravel({ id: 'ravel-update', messages: [{ id: 'old', author: 'user', body: 'old', createdAt: NOW, delivery: 'delivered' }] }))

    expect(store.updateRavel('ravel-update', { status: 'completed', error: 'done' })).toMatchObject({ status: 'completed', error: 'done' })
    expect(readStoreFile(file).ravel[0]).toMatchObject({ status: 'completed', error: 'done' })

    const replacement = ravel({ id: 'ravel-update', name: 'Replacement', status: 'paused', messages: [], plan: null })
    expect(store.replaceRavel('ravel-update', replacement)).toEqual(replacement)

    expect(store.getRavelById('ravel-update')).toEqual(replacement)
    expect(readStoreFile(file).ravel[0]).toEqual(replacement)
  })

  test.each([
    {
      name: 'addRepo',
      fail: (store: ConductorStore) =>
        store.addRepo({ id: 'failed-repo', path: 'D:/Failed', name: 'Failed', addedAt: NOW }),
      later: (store: ConductorStore) =>
        store.addRepo({ id: 'later-repo', path: 'D:/Later', name: 'Later', addedAt: NOW }),
      assertLater: (shape: StoreShapeV2) => {
        expect(shape.repos.map((repo) => repo.id)).toEqual(['repo-1', 'later-repo'])
      }
    },
    {
      name: 'removeRepo',
      fail: (store: ConductorStore) => store.removeRepo('repo-1'),
      later: (store: ConductorStore) =>
        store.addRepo({ id: 'later-repo', path: 'D:/Later', name: 'Later', addedAt: NOW }),
      assertLater: (shape: StoreShapeV2) => {
        expect(shape.repos.map((repo) => repo.id)).toEqual(['repo-1', 'later-repo'])
      }
    },
    {
      name: 'saveSettings',
      fail: (store: ConductorStore) => store.saveSettings({ defaultHarness: 'codex' }),
      later: (store: ConductorStore) => store.saveSettings({ harnessModels: { zai: 'zai/new-model' } }),
      assertLater: (shape: StoreShapeV2) => {
        expect(shape.settings.defaultHarness).toBe('claude')
        expect(shape.settings.harnessModels.zai).toBe('zai/new-model')
      }
    },
    {
      name: 'trackWorktree',
      fail: (store: ConductorStore) =>
        store.trackWorktree('D:/Repo/.worktrees/failed', {
          repoId: 'repo-1',
          repoPath: 'D:/Repo',
          branch: 'failed'
        }),
      later: (store: ConductorStore) =>
        store.trackWorktree('D:/Repo/.worktrees/later', {
          repoId: 'repo-1',
          repoPath: 'D:/Repo',
          branch: 'later'
        }),
      assertLater: (shape: StoreShapeV2) => {
        expect(Object.keys(shape.worktrees).sort()).toEqual([
          'D:/Repo/.worktrees/later',
          'D:/Repo/.worktrees/one'
        ])
      }
    },
    {
      name: 'untrackWorktree',
      fail: (store: ConductorStore) => store.untrackWorktree('D:/Repo/.worktrees/one'),
      later: (store: ConductorStore) =>
        store.trackWorktree('D:/Repo/.worktrees/later', {
          repoId: 'repo-1',
          repoPath: 'D:/Repo',
          branch: 'later'
        }),
      assertLater: (shape: StoreShapeV2) => {
        expect(Object.keys(shape.worktrees).sort()).toEqual([
          'D:/Repo/.worktrees/later',
          'D:/Repo/.worktrees/one'
        ])
      }
    },
    {
      name: 'addRavel',
      fail: (store: ConductorStore) => store.addRavel(ravel({ id: 'failed-ravel' })),
      later: (store: ConductorStore) => store.addRavel(ravel({ id: 'later-ravel' })),
      assertLater: (shape: StoreShapeV2) => {
        expect(shape.ravel.map((item) => item.id)).toEqual(['ravel-1', 'later-ravel'])
      }
    },
    {
      name: 'replaceRavel',
      fail: (store: ConductorStore) =>
        store.replaceRavel('ravel-1', ravel({ id: 'ravel-1', name: 'Failed Replacement' })),
      later: (store: ConductorStore) => store.addRavel(ravel({ id: 'later-ravel' })),
      assertLater: (shape: StoreShapeV2) => {
        expect(shape.ravel.map((item) => item.name)).toEqual(['Original Ravel', 'Ravel'])
      }
    },
    {
      name: 'updateRavel',
      fail: (store: ConductorStore) => store.updateRavel('ravel-1', { name: 'Failed Update' }),
      later: (store: ConductorStore) => store.addRavel(ravel({ id: 'later-ravel' })),
      assertLater: (shape: StoreShapeV2) => {
        expect(shape.ravel.map((item) => item.name)).toEqual(['Original Ravel', 'Ravel'])
      }
    },
    {
      name: 'removeRavel',
      fail: (store: ConductorStore) => store.removeRavel('ravel-1'),
      later: (store: ConductorStore) => store.addRavel(ravel({ id: 'later-ravel' })),
      assertLater: (shape: StoreShapeV2) => {
        expect(shape.ravel.map((item) => item.id)).toEqual(['ravel-1', 'later-ravel'])
      }
    }
  ])('$name is transactional when persistence fails', async ({ fail, later, assertLater }) => {
    const { createStoreForPath, failWrites, allowWrites } = await importStoreWithControllableRename()
    const file = tempStoreFile()
    writeJson(file, seededShape())
    const store = createStoreForPath(file)
    store.init()
    const before = storeSnapshot(store)
    const fileBefore = readFileSync(file, 'utf8')

    failWrites()
    expect(() => fail(store)).toThrow('simulated persist failure')

    expect(storeSnapshot(store)).toEqual(before)
    expect(readFileSync(file, 'utf8')).toBe(fileBefore)

    allowWrites()
    later(store)

    const persisted = readStoreFile(file)
    assertLater(persisted)
    expect(JSON.stringify(persisted)).not.toContain('Failed')
    expect(JSON.stringify(persisted)).not.toContain('failed-ravel')
    expect(JSON.stringify(persisted)).not.toContain('failed-repo')
  })

  test('getters and mutation returns are snapshots that cannot mutate cache or later persistence', async () => {
    const { createStoreForPath } = await importStore()
    const file = tempStoreFile()
    writeJson(file, seededShape())
    const store = createStoreForPath(file)
    store.init()

    const settingsResult = store.saveSettings({ hooks: { global: null, perRepo: { repo: 'echo ok' } } })
    settingsResult.hooks.perRepo.repo = 'mutated settings result'
    const settingsSnapshot = store.getSettings()
    settingsSnapshot.hooks.perRepo.repo = 'mutated settings getter'

    const worktreesSnapshot = store.getWorktrees()
    worktreesSnapshot['D:/Repo/.worktrees/one'].branch = 'mutated worktree getter'
    worktreesSnapshot['D:/Repo/.worktrees/mutated'] = {
      repoId: 'repo-1',
      repoPath: 'D:/Repo',
      branch: 'mutated',
      createdAt: NOW
    }

    const input = ravel({
      id: 'snapshot-ravel',
      messages: [{ id: 'input-message', author: 'user', body: 'original input', createdAt: NOW, delivery: 'delivered' }]
    })
    const addResult = store.addRavel(input)
    input.messages[0].body = 'mutated add input'
    addResult.messages[0].body = 'mutated add result'

    const updateResult = store.updateRavel('snapshot-ravel', {
      messages: [{ id: 'updated-message', author: 'user', body: 'updated body', createdAt: NOW, delivery: 'delivered' }]
    })
    expect(updateResult).toBeDefined()
    updateResult!.messages[0].body = 'mutated update result'

    const replacement = ravel({
      id: 'snapshot-ravel',
      messages: [{ id: 'replacement-message', author: 'user', body: 'replacement body', createdAt: NOW, delivery: 'delivered' }]
    })
    const replaceResult = store.replaceRavel('snapshot-ravel', replacement)
    replacement.messages[0].body = 'mutated replace input'
    expect(replaceResult).toBeDefined()
    replaceResult!.messages[0].body = 'mutated replace result'

    store.addRepo({ id: 'later-repo', path: 'D:/Later', name: 'Later', addedAt: NOW })

    expect(store.getSettings().hooks.perRepo.repo).toBe('echo ok')
    expect(store.getWorktrees()['D:/Repo/.worktrees/one'].branch).toBe('one')
    expect(store.getWorktrees()).not.toHaveProperty('D:/Repo/.worktrees/mutated')
    expect(store.getRavelById('snapshot-ravel')?.messages[0].body).toBe('replacement body')
    expect(JSON.stringify(readStoreFile(file))).not.toContain('mutated')
  })

  test.each([
    {
      name: 'addRepo',
      write: (store: ConductorStore) =>
        store.addRepo({ id: 'bad-repo', path: 'D:/Bad', name: 4, addedAt: NOW } as unknown as Parameters<ConductorStore['addRepo']>[0])
    },
    {
      name: 'saveSettings',
      write: (store: ConductorStore) => store.saveSettings({ harnessArgs: { claude: ['--ok', 7] } as unknown as Parameters<ConductorStore['saveSettings']>[0]['harnessArgs'] })
    },
    {
      name: 'trackWorktree',
      write: (store: ConductorStore) =>
        store.trackWorktree('D:/Repo/.worktrees/bad', { repoId: 'repo-1', repoPath: 'D:/Repo', branch: 9 } as unknown as Parameters<ConductorStore['trackWorktree']>[1])
    },
    {
      name: 'addRavel',
      write: (store: ConductorStore) =>
        store.addRavel({ ...ravel({ id: 'bad-ravel' }), messages: [{ id: 'msg', author: 'agent', body: 'bad', createdAt: NOW, delivery: 'delivered' }] } as unknown as RavelConfig)
    },
    {
      name: 'replaceRavel',
      write: (store: ConductorStore) =>
        store.replaceRavel('ravel-1', { ...ravel({ id: 'ravel-1' }), dispatches: [{ ...dispatch(), status: 'queued' }] } as unknown as RavelConfig)
    },
    {
      name: 'updateRavel',
      write: (store: ConductorStore) =>
        store.updateRavel('ravel-1', { plan: { ...ravel().plan, revision: 'bad' } as unknown as RavelConfig['plan'] })
    }
  ])('invalid $name input throws and leaves cache and file unchanged', async ({ write }) => {
    const { createStoreForPath } = await importStore()
    const file = tempStoreFile()
    writeJson(file, seededShape())
    const store = createStoreForPath(file)
    store.init()
    const before = storeSnapshot(store)
    const fileBefore = readFileSync(file, 'utf8')

    expect(() => write(store)).toThrow()

    expect(storeSnapshot(store)).toEqual(before)
    expect(readFileSync(file, 'utf8')).toBe(fileBefore)
  })

  test('repo paths dedupe by normalized Windows identity while preserving the first stored display path', async () => {
    const { createStoreForPath } = await importStore()
    const file = tempStoreFile()
    const store = createStoreForPath(file)
    store.init()
    const first = { id: 'repo-1', path: 'D:/Repo/Project', name: 'Project', addedAt: NOW }
    const duplicate = { id: 'repo-2', path: 'd:\\\\repo\\\\project\\\\', name: 'Duplicate', addedAt: NOW + 1 }

    expect(store.addRepo(first)).toEqual(first)
    expect(store.addRepo(duplicate)).toEqual(first)

    expect(store.getRepos()).toEqual([first])
    expect(readStoreFile(file).repos).toEqual([first])
  })

  test('worktree track and untrack use normalized Windows identity while preserving the first stored key', async () => {
    const { createStoreForPath } = await importStore()
    const file = tempStoreFile()
    const store = createStoreForPath(file)
    store.init()

    store.trackWorktree('D:/Repo/.worktrees/Feature/', {
      repoId: 'repo-1',
      repoPath: 'D:/Repo',
      branch: 'feature',
    })
    store.trackWorktree('d:\\\\repo\\\\.worktrees\\\\feature', {
      repoId: 'repo-1',
      repoPath: 'D:/Repo',
      branch: 'feature-updated',
    })

    expect(Object.keys(store.getWorktrees())).toEqual(['D:/Repo/.worktrees/Feature/'])
    expect(store.getWorktrees()['D:/Repo/.worktrees/Feature/'].branch).toBe('feature-updated')

    store.untrackWorktree('D:\\\\REPO\\\\.worktrees\\\\feature\\\\')

    expect(store.getWorktrees()).toEqual({})
    expect(readStoreFile(file).worktrees).toEqual({})
  })
})
