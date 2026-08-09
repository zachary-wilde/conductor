import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { CreateRavelRequest, PublicRavelConfig, RavelActionResult, RavelPlan, Repo, Session } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import { useStore } from '../store/useStore'
import { installApi, resetStore, ravelFixture as ravel } from './testStubs'

const NOW = 1_720_000_000_000

function plan(overrides: Partial<RavelPlan> = {}): RavelPlan {
  return {
    revision: 1,
    createdAt: NOW,
    sourceMessageIds: ['msg-1'],
    orientation: 'Shipping the thing.',
    mission: {
      goal: 'Ship',
      context: [],
      constraints: [],
      acceptanceCriteria: [],
      assumptions: []
    },
    briefs: [],
    approvedAt: null,
    approvedRevision: null,
    ...overrides
  }
}

function createRequest(overrides: Partial<CreateRavelRequest> = {}): CreateRavelRequest {
  return {
    name: 'Ravel',
    repoId: 'repo-1',
    repoPath: 'D:/repo',
    harness: 'claude',
    ...overrides
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.restoreAllMocks()
  installApi()
  resetStore()
})

describe('Ravel store race handling', () => {
  test('keeps busy true until overlapping Ravel operations have all settled', async () => {
    const create = deferred<RavelActionResult>()
    const pause = deferred<RavelActionResult | null>()
    vi.mocked(window.api.createRavel).mockReturnValue(create.promise)
    vi.mocked(window.api.pauseRavel).mockReturnValue(pause.promise)

    const createPromise = useStore.getState().createRavel(createRequest())
    expect(useStore.getState().busy).toBe(true)
    const pausePromise = useStore.getState().pauseRavel('ravel-1')
    expect(useStore.getState().busy).toBe(true)

    pause.resolve({ ok: true, ravel: ravel({ status: 'paused' }) })
    await pausePromise
    expect(useStore.getState().busy).toBe(true)

    create.resolve({ ok: true, ravel: ravel() })
    await createPromise
    expect(useStore.getState().busy).toBe(false)
  })

  test('handled IPC failures set visible errors without rejecting store actions', async () => {
    vi.mocked(window.api.createRavel).mockRejectedValue(new Error('IPC down'))

    await expect(useStore.getState().createRavel(createRequest())).resolves.toBeNull()

    expect(useStore.getState().error).toBe('IPC down')
    expect(useStore.getState().busy).toBe(false)
  })

  test('init preserves existing state and names the subsystem when initial IPC loading fails', async () => {
    const existingRepo: Repo = { id: 'repo-1', name: 'Repo', path: 'D:/repo', addedAt: NOW }
    resetStore({ repos: [existingRepo] })
    vi.mocked(window.api.listRepos).mockRejectedValue(new Error('list failed'))

    await expect(useStore.getState().init()).resolves.toBeUndefined()

    expect(useStore.getState().repos).toEqual([existingRepo])
    expect(useStore.getState().error).toBe('Some state could not be loaded — repositories: list failed')
  })

  test('init keeps the calls that succeeded when one of them fails', async () => {
    const settings = { ...DEFAULT_SETTINGS, theme: 'terminal' as const }
    installApi({
      getSettings: vi.fn().mockResolvedValue(settings),
      listRavel: vi.fn().mockResolvedValue([ravel({ id: 'kept-ravel' })]),
      detectHarnesses: vi.fn().mockRejectedValue(new Error('probe failed'))
    })
    resetStore()

    await useStore.getState().init()

    // The whole batch used to reject together, so one failing probe discarded
    // the settings and lists that had already resolved.
    expect(useStore.getState().settings.theme).toBe('terminal')
    expect(useStore.getState().ravelList.map((item) => item.id)).toEqual(['kept-ravel'])
    expect(useStore.getState().error).toContain('harnesses: probe failed')
  })

  test('init reports a failed store load and outranks other load failures', async () => {
    installApi({
      getSettingsLoadError: vi.fn().mockResolvedValue('unexpected token } in JSON'),
      listRepos: vi.fn().mockRejectedValue(new Error('list failed'))
    })
    resetStore()

    await useStore.getState().init()

    const error = useStore.getState().error ?? ''
    expect(error).toContain('will not overwrite your file')
    expect(error).toContain('unexpected token } in JSON')
    expect(error).not.toContain('list failed')
  })

  test('hydrateRavel merges persisted log entries and child sessions into the store', async () => {
    const entry = {
      id: 'log-1',
      ravelId: 'ravel-1',
      ts: NOW,
      level: 'info' as const,
      event: 'spawn',
      text: 'spawned brief-1'
    }
    const child = {
      id: 'child-1',
      name: 'brief-1',
      status: 'running'
    } as unknown as Session
    installApi({
      getRavelLog: vi.fn().mockResolvedValue([entry]),
      getRavelChildren: vi.fn().mockResolvedValue([child])
    })
    resetStore()

    await useStore.getState().hydrateRavel('ravel-1')

    // onRavelLog only streams entries emitted while this window listens, so
    // without an explicit fetch the Log and Manager tabs stayed empty.
    expect(useStore.getState().ravelLogs['ravel-1']).toEqual([entry])
    expect(useStore.getState().sessions.map((session) => session.id)).toContain('child-1')
  })

  test('successful delete tombstones Ravel ids so stale events and refreshes cannot resurrect them', async () => {
    const deleted = ravel({ id: 'deleted-ravel' })
    const listeners: { update?: (cfg: PublicRavelConfig) => void } = {}
    installApi({
      onRavelUpdate: vi.fn((cb) => {
        listeners.update = cb
        return vi.fn()
      }),
      deleteRavel: vi.fn().mockResolvedValue({ ok: true, ravel: deleted }),
      listRavel: vi.fn().mockResolvedValue([])
    })
    resetStore({ ravelList: [deleted], selectedRavelId: deleted.id, view: 'ravel' })
    await useStore.getState().init()

    await useStore.getState().deleteRavel(deleted.id)
    expect(useStore.getState().ravelList).toEqual([])

    if (listeners.update === undefined) throw new Error('Ravel update listener was not registered.')
    listeners.update(deleted)
    expect(useStore.getState().ravelList).toEqual([])

    vi.mocked(window.api.listRavel).mockResolvedValue([deleted])
    await useStore.getState().refreshRavel()
    expect(useStore.getState().ravelList).toEqual([])
  })

  test('init subscribes before async list load and ignores stale snapshots for updated Ravel ids', async () => {
    const pendingList = deferred<PublicRavelConfig[]>()
    const stale = ravel({ id: 'ravel-race', status: 'idle', plan: null })
    const updatedPlan = plan({ revision: 2 })
    const updated = ravel({ id: stale.id, status: 'awaiting-approval', activity: 'thinking', plan: updatedPlan })
    const listeners: { update?: (cfg: PublicRavelConfig) => void } = {}
    installApi({
      listRavel: vi.fn().mockReturnValue(pendingList.promise),
      onRavelUpdate: vi.fn((cb) => {
        listeners.update = cb
        return vi.fn()
      })
    })
    resetStore()

    const initPromise = useStore.getState().init()
    if (listeners.update === undefined) throw new Error('Ravel update listener was not registered before listRavel resolved.')

    listeners.update(updated)
    pendingList.resolve([stale])
    await initPromise

    expect(useStore.getState().ravelList).toHaveLength(1)
    expect(useStore.getState().ravelList[0].id).toBe(stale.id)
    expect(useStore.getState().ravelList[0].status).toBe('awaiting-approval')
    expect(useStore.getState().ravelList[0].activity).toBe('thinking')
    expect(useStore.getState().ravelList[0].plan).toBe(updatedPlan)
  })
})
