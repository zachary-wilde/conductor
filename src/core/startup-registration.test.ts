import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'

// `mock`-prefixed so vitest's vi.mock hoisting rule permits the reference.
const mockExecFile = vi.fn()

vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...(args as never[]))
}))

import { registerAtLogin, unregisterAtLogin, isRegisteredAtLogin } from './startup-registration'

// Frozen contract asserted verbatim below (defined once at the top of the module
// under test); repeated here so a typo is caught rather than self-confirmed.
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const VALUE_NAME = 'ConductorCore'
const SKIP_WARN = '[core] sign-in registration is Windows-only; skipping'

const ORIGINAL_PLATFORM = process.platform
// The win32 branch is forced on so the reg-path tests are deterministic even on
// a non-Windows host; the off-Windows suite forces a non-win32 platform.

let warnSpy: MockInstance

beforeEach(() => {
  mockExecFile.mockReset()
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  warnSpy.mockRestore()
  Object.defineProperty(process, 'platform', {
    value: ORIGINAL_PLATFORM,
    configurable: true
  })
})

describe('startup registration — win32 path', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  })

  it('registerAtLogin invokes reg add with the exact argv', async () => {
    mockExecFile.mockImplementation((_file, _args, _opts, cb) =>
      cb(null, { stdout: '', stderr: '' })
    )
    await registerAtLogin('C:/path/core.exe')
    expect(mockExecFile).toHaveBeenCalledTimes(1)
    expect(mockExecFile).toHaveBeenCalledWith(
      'reg',
      ['add', RUN_KEY, '/v', VALUE_NAME, '/t', 'REG_SZ', '/d', 'C:/path/core.exe', '/f'],
      { windowsHide: true },
      expect.any(Function)
    )
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('registerAtLogin surfaces trimmed stderr on a nonzero exit', async () => {
    const fail = Object.assign(new Error('reg failed'), { stderr: '  access denied  ' })
    mockExecFile.mockImplementation((_file, _args, _opts, cb) => cb(fail, undefined))
    await expect(registerAtLogin('C:/path/core.exe')).rejects.toThrow('access denied')
  })

  it('unregisterAtLogin invokes reg delete with the exact argv', async () => {
    mockExecFile.mockImplementation((_file, _args, _opts, cb) =>
      cb(null, { stdout: '', stderr: '' })
    )
    await unregisterAtLogin()
    expect(mockExecFile).toHaveBeenCalledWith(
      'reg',
      ['delete', RUN_KEY, '/v', VALUE_NAME, '/f'],
      { windowsHide: true },
      expect.any(Function)
    )
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('unregisterAtLogin surfaces trimmed stderr on a nonzero exit', async () => {
    const fail = Object.assign(new Error('reg failed'), { stderr: '  no such value  ' })
    mockExecFile.mockImplementation((_file, _args, _opts, cb) => cb(fail, undefined))
    await expect(unregisterAtLogin()).rejects.toThrow('no such value')
  })

  it('isRegisteredAtLogin returns true and queries the value when it exists', async () => {
    mockExecFile.mockImplementation((_file, _args, _opts, cb) =>
      cb(null, { stdout: `    ${VALUE_NAME}    REG_SZ    C:/path/core.exe`, stderr: '' })
    )
    expect(await isRegisteredAtLogin()).toBe(true)
    expect(mockExecFile).toHaveBeenCalledWith(
      'reg',
      ['query', RUN_KEY, '/v', VALUE_NAME],
      { windowsHide: true },
      expect.any(Function)
    )
  })

  it('isRegisteredAtLogin swallows a failed query into false', async () => {
    mockExecFile.mockImplementation((_file, _args, _opts, cb) =>
      cb(Object.assign(new Error('not found'), { code: 1 }), undefined)
    )
    expect(await isRegisteredAtLogin()).toBe(false)
  })
})

describe('startup registration — off Windows is a silent no-op', () => {
  it('does not call reg, warns once per call, and the boolean returns false', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })

    await registerAtLogin('C:/path/core.exe')
    await unregisterAtLogin()
    expect(await isRegisteredAtLogin()).toBe(false)

    expect(mockExecFile).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledTimes(3)
    expect(warnSpy).toHaveBeenNthCalledWith(1, SKIP_WARN)
    expect(warnSpy).toHaveBeenNthCalledWith(2, SKIP_WARN)
    expect(warnSpy).toHaveBeenNthCalledWith(3, SKIP_WARN)
  })
})
