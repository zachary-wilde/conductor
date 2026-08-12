import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const updater = new EventEmitter() as EventEmitter & {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  setFeedURL: (options: unknown) => void
  checkForUpdates: ReturnType<typeof vi.fn>
  downloadUpdate: ReturnType<typeof vi.fn>
  quitAndInstall: ReturnType<typeof vi.fn>
}
updater.autoDownload = true
updater.autoInstallOnAppQuit = true
updater.setFeedURL = vi.fn()
updater.checkForUpdates = vi.fn(async () => undefined)
updater.downloadUpdate = vi.fn(async () => undefined)
updater.quitAndInstall = vi.fn()

vi.mock('electron', () => ({ app: { isPackaged: true } }))
vi.mock('electron-updater', () => ({ autoUpdater: updater }))

const {
  checkForUpdaterUpdates,
  downloadUpdaterUpdate,
  getUpdaterStatus,
  initializeUpdater,
  installUpdaterUpdate,
  subscribeUpdater
} = await import('./updater')

describe('updater', () => {
  beforeEach(() => {
    updater.checkForUpdates.mockClear()
    updater.downloadUpdate.mockClear()
    updater.quitAndInstall.mockClear()
    initializeUpdater()
  })

  test('publishes update lifecycle events and disables automatic installation', () => {
    const statuses: string[] = []
    const unsubscribe = subscribeUpdater((next) => statuses.push(next.state))

    updater.emit('checking-for-update')
    updater.emit('update-available', { version: '0.2.0' })
    updater.emit('download-progress', {
      percent: 42,
      transferred: 42,
      total: 100,
      bytesPerSecond: 10
    })
    updater.emit('update-downloaded', { version: '0.2.0' })

    expect(statuses).toEqual(['checking', 'available', 'downloading', 'downloaded'])
    expect(getUpdaterStatus()).toMatchObject({ state: 'downloaded', version: '0.2.0' })
    expect(updater.autoDownload).toBe(false)
    expect(updater.autoInstallOnAppQuit).toBe(false)
    unsubscribe()
  })

  test('blocks installation while sessions are active unless explicitly confirmed', async () => {
    initializeUpdater(async () => true)

    await expect(installUpdaterUpdate()).rejects.toThrow('Active sessions must be confirmed')
    expect(updater.quitAndInstall).not.toHaveBeenCalled()

    await installUpdaterUpdate(true)
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true)
  })

  test('delegates explicit check and download actions', async () => {
    await checkForUpdaterUpdates()
    await downloadUpdaterUpdate()
    expect(updater.checkForUpdates).toHaveBeenCalledOnce()
    expect(updater.downloadUpdate).toHaveBeenCalledOnce()
  })
})
