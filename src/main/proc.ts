import { execFileSync } from 'node:child_process'

/**
 * Harnesses run as `cmd.exe /d /c <shim>`, so the CLI is a grandchild of the
 * process Conductor spawned. Windows does not cascade kills, and killing the
 * direct child only reaps cmd.exe -- which orphans the harness and leaves it
 * burning quota after Conductor exits. Kill the whole tree, synchronously, so
 * it also works during app shutdown.
 */
export function killProcessTree(pid: number | undefined): void {
  if (process.platform !== 'win32' || !pid) return
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000 })
  } catch {
    /* already gone, or never started */
  }
}
