// Windows sign-in registration for the standalone Conductor Core.
//
// Registers the Core to launch in the current user's context at sign-in via the
// per-user registry Run key (userland — no admin elevation), and removes that
// registration on uninstall. Uses `reg.exe` with an argv array (never a shell
// string) so the launch string is passed verbatim with no quoting/injection
// surface. Off Windows every entry point is a no-op that warns once and never
// throws, so the same call sites are safe on any platform.
//
// Deliberately Electron-free: the Core is a plain Node process, and this module
// touches only the per-user registry, so it is unit-testable with a mocked
// `node:child_process` and touches no real registry state.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const VALUE_NAME = 'ConductorCore'
const SKIP_WARN = '[core] sign-in registration is Windows-only; skipping'

/**
 * Register `command` (the full launch string, e.g. the Core exe path) to run at
 * Windows sign-in. Rejects (surfacing stderr) when `reg.exe` exits non-zero so a
 * failed install is visible. No-op off Windows.
 */
export async function registerAtLogin(command: string): Promise<void> {
  if (process.platform !== 'win32') {
    console.warn(SKIP_WARN)
    return
  }
  try {
    await execFileP(
      'reg',
      ['add', RUN_KEY, '/v', VALUE_NAME, '/t', 'REG_SZ', '/d', command, '/f'],
      { windowsHide: true }
    )
  } catch (e) {
    const err = e as Error & { stderr?: string }
    throw new Error(err.stderr?.trim() || err.message)
  }
}

/**
 * Remove the sign-in registration. Rejects (surfacing stderr) when `reg.exe`
 * exits non-zero. No-op off Windows.
 */
export async function unregisterAtLogin(): Promise<void> {
  if (process.platform !== 'win32') {
    console.warn(SKIP_WARN)
    return
  }
  try {
    await execFileP('reg', ['delete', RUN_KEY, '/v', VALUE_NAME, '/f'], {
      windowsHide: true
    })
  } catch (e) {
    const err = e as Error & { stderr?: string }
    throw new Error(err.stderr?.trim() || err.message)
  }
}

/**
 * Whether the sign-in registration currently exists. A non-zero query exit
 * (including "value not found") resolves to `false`. Returns `false` off
 * Windows.
 */
export async function isRegisteredAtLogin(): Promise<boolean> {
  if (process.platform !== 'win32') {
    console.warn(SKIP_WARN)
    return false
  }
  try {
    await execFileP('reg', ['query', RUN_KEY, '/v', VALUE_NAME], {
      windowsHide: true
    })
    return true
  } catch {
    return false
  }
}
