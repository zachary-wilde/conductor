import { describe, it, expect, vi, beforeEach } from 'vitest'

// `electron` and the registry module are mocked: this test drives the desktop
// autostart POLICY (packaged-only, command shape, error swallowing) without a
// real Electron runtime or touching the registry.
const { appMock, registerAtLogin, unregisterAtLogin } = vi.hoisted(() => ({
  appMock: { isPackaged: false },
  registerAtLogin: vi.fn<(command: string) => Promise<void>>(),
  unregisterAtLogin: vi.fn<() => Promise<void>>()
}))
vi.mock('electron', () => ({ app: appMock }))
vi.mock('../core/startup-registration', () => ({ registerAtLogin, unregisterAtLogin }))

import { isBackgroundLaunch, autostartCommand, syncAutostart, BACKGROUND_FLAG } from './autostart'

beforeEach(() => {
  registerAtLogin.mockReset()
  registerAtLogin.mockResolvedValue(undefined)
  unregisterAtLogin.mockReset()
  unregisterAtLogin.mockResolvedValue(undefined)
  appMock.isPackaged = false
})

describe('isBackgroundLaunch', () => {
  it('detects the background flag among argv', () => {
    expect(isBackgroundLaunch(['electron', '.', BACKGROUND_FLAG])).toBe(true)
    expect(isBackgroundLaunch(['electron', '.'])).toBe(false)
  })
})

describe('autostartCommand', () => {
  it('quotes the exe path and appends the background flag', () => {
    expect(autostartCommand('C:\\Program Files\\Conductor\\Conductor.exe')).toBe(
      '"C:\\Program Files\\Conductor\\Conductor.exe" --background'
    )
  })
})

describe('syncAutostart', () => {
  it('does not touch the registry in a dev (unpackaged) run', async () => {
    appMock.isPackaged = false
    await syncAutostart(true)
    await syncAutostart(false)
    expect(registerAtLogin).not.toHaveBeenCalled()
    expect(unregisterAtLogin).not.toHaveBeenCalled()
  })

  it('registers this exe in background mode when enabled in a packaged run', async () => {
    appMock.isPackaged = true
    await syncAutostart(true)
    expect(registerAtLogin).toHaveBeenCalledTimes(1)
    expect(registerAtLogin).toHaveBeenCalledWith(autostartCommand(process.execPath))
    expect(unregisterAtLogin).not.toHaveBeenCalled()
  })

  it('unregisters the sign-in entry when disabled in a packaged run', async () => {
    appMock.isPackaged = true
    await syncAutostart(false)
    expect(unregisterAtLogin).toHaveBeenCalledTimes(1)
    expect(registerAtLogin).not.toHaveBeenCalled()
  })

  it('swallows registry failures so boot is never blocked', async () => {
    appMock.isPackaged = true
    registerAtLogin.mockRejectedValueOnce(new Error('reg.exe failed'))
    unregisterAtLogin.mockRejectedValueOnce(new Error('reg.exe failed'))
    await expect(syncAutostart(true)).resolves.toBeUndefined()
    await expect(syncAutostart(false)).resolves.toBeUndefined()
  })
})
