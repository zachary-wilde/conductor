import { beforeEach, describe, expect, test, vi } from 'vitest'
import { installApi, resetStore } from './testStubs'
import { useStore } from '../store/useStore'

beforeEach(() => {
  vi.restoreAllMocks()
  installApi()
  resetStore()
})

/**
 * The callback `subscribeToEvents` handed to `window.api.onCoreStatus`. Shared by
 * the three tests that simulate a pushed status event. The refreshes a
 * `connected` transition fires call their IPC mock synchronously before the
 * first await, so call counts are observable without a timer.
 */
function coreStatusCallback() {
  return vi.mocked(window.api.onCoreStatus).mock.calls[0][0]
}

describe('Core status store wiring', () => {
  test('init seeds coreStatus from window.api.getCoreStatus()', async () => {
    installApi({ getCoreStatus: vi.fn().mockResolvedValue({ state: 'connected' }) })
    await useStore.getState().init()
    expect(useStore.getState().coreStatus).toEqual({ state: 'connected' })
  })

  test('init leaves the connecting default when getCoreStatus rejects', async () => {
    installApi({ getCoreStatus: vi.fn().mockRejectedValue(new Error('no core')) })
    await useStore.getState().init()
    expect(useStore.getState().coreStatus).toEqual({ state: 'connecting' })
  })

  test('a pushed onCoreStatus event updates coreStatus', async () => {
    await useStore.getState().init()
    coreStatusCallback()({ state: 'error', detail: 'boom' })
    expect(useStore.getState().coreStatus).toEqual({ state: 'error', detail: 'boom' })
  })

  test('a transition into connected triggers refreshAll and repopulates sessions', async () => {
    const listSessions = vi.fn().mockResolvedValue([{ id: 'fresh' }])
    installApi({ listSessions, getCoreStatus: vi.fn().mockResolvedValue({ state: 'connecting' }) })
    await useStore.getState().init()
    const callsAfterInit = listSessions.mock.calls.length

    coreStatusCallback()({ state: 'connected' })
    await Promise.resolve() // settle the resolved mock → refreshSessions applies `set`

    expect(listSessions.mock.calls.length).toBeGreaterThan(callsAfterInit)
    expect(useStore.getState().sessions).toEqual([{ id: 'fresh' }])
    expect(useStore.getState().coreStatus.state).toBe('connected')
  })

  test('a repeat connected event while already connected does NOT refresh again', async () => {
    const listSessions = vi.fn().mockResolvedValue([])
    installApi({ listSessions, getCoreStatus: vi.fn().mockResolvedValue({ state: 'connected' }) })
    await useStore.getState().init()
    const callsAfterInit = listSessions.mock.calls.length

    coreStatusCallback()({ state: 'connected' })
    await Promise.resolve()

    expect(listSessions.mock.calls.length).toBe(callsAfterInit)
  })

  test('reconnectCore calls window.api.reconnectCore and flips to connecting', async () => {
    await useStore.getState().init()
    useStore.setState({ coreStatus: { state: 'error', detail: 'x' } })

    await useStore.getState().reconnectCore()

    expect(window.api.reconnectCore).toHaveBeenCalled()
    expect(useStore.getState().coreStatus).toEqual({ state: 'connecting' })
  })
})
