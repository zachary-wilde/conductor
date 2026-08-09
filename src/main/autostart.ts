// Windows sign-in autostart wiring for the desktop app.
//
// The standalone Core is what should survive sign-out/reboot so scheduled
// automations and heartbeats keep firing. We register THIS packaged executable
// with a `--background` flag in the per-user Run key; at sign-in Windows relaunches
// it, the app ensures the detached Core is running, then exits (no window). The
// user opens Conductor normally later and connects to that already-running Core.
//
// The registry write itself lives in the Electron-free, unit-tested
// `core/startup-registration` module; this module owns only the desktop policy:
// WHEN to reconcile the setting (packaged builds only) and WHAT command to register.

import { app } from 'electron'
import { registerAtLogin, unregisterAtLogin } from '../core/startup-registration'

/** The flag the Run key passes so a relaunch boots the headless background Core. */
export const BACKGROUND_FLAG = '--background'

/** Whether this process was launched by the sign-in autostart entry. */
export function isBackgroundLaunch(argv: readonly string[]): boolean {
  return argv.includes(BACKGROUND_FLAG)
}

/** The launch string registered in the Run key: this exe, relaunched in background mode. */
export function autostartCommand(exePath: string): string {
  return `"${exePath}" ${BACKGROUND_FLAG}`
}

/**
 * Reconcile sign-in autostart with the user's setting. Packaged builds only -
 * a dev run must never write the user's Run key. Never throws: a failed
 * registration or removal is logged and swallowed so it can't take down boot.
 */
export async function syncAutostart(enabled: boolean): Promise<void> {
  if (!app.isPackaged) return
  try {
    if (enabled) {
      await registerAtLogin(autostartCommand(process.execPath))
    } else {
      await unregisterAtLogin()
    }
  } catch (error) {
    console.error(`[conductor] failed to ${enabled ? 'register' : 'unregister'} sign-in autostart`, error)
  }
}
