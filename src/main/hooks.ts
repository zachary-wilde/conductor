import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { killProcessTree } from './proc'

const execFileP = promisify(execFile)

let bashPath: string | null | undefined

/**
 * True for the Windows launchers that answer to the name `bash` but are not a
 * shell we can run a worktree script in.
 *
 * `System32\bash.exe` and the `WindowsApps\bash.exe` execution alias are both the
 * WSL launcher, and both come before Git's bash on a default PATH. With no
 * distribution installed they fail with a Microsoft Store advert; with one
 * installed they run the script inside Linux, where the Windows worktree path
 * they were handed does not exist. Either way the verdict is wrong, and it is
 * reported as a failing hook rather than a missing shell.
 */
export function isWslBashLauncher(path: string): boolean {
  return /\\(?:System32|Sysnative|WindowsApps)\\bash\.exe$/i.test(path)
}

/** Locate bash (Git for Windows ships one). Cached after first lookup. */
async function findBash(): Promise<string | null> {
  if (bashPath !== undefined) return bashPath
  try {
    const { stdout } = await execFileP('where.exe', ['bash'], { windowsHide: true })
    bashPath =
      stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((p) => p.length > 0 && !isWslBashLauncher(p))
        .find(Boolean) ?? null
  } catch {
    bashPath = null
  }
  return bashPath
}

export interface HookResult {
  ok: boolean
  exitCode: number | null
  stdout: string
  stderr: string
  ranWith: string
}

/**
 * Run a script in a worktree. Contract: WORKTREE_PATH / REPO_PATH / BRANCH env
 * vars, cwd = the worktree. Used for the post-create hook and for the repo's
 * verify command, which is why it takes an abort signal: a verify command
 * outlives nothing — a paused, deleted or budget-stopped Ravel kills it.
 */
export async function runHook(
  script: string,
  ctx: { worktreePath: string; repoPath: string; branch: string },
  timeoutMs = 120_000,
  signal?: AbortSignal
): Promise<HookResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WORKTREE_PATH: ctx.worktreePath,
    REPO_PATH: ctx.repoPath,
    BRANCH: ctx.branch
  }

  const bash = await findBash()
  if (bash) return runScript(bash, ['-c', script], ctx.worktreePath, env, timeoutMs, bash, signal)
  return runViaCmd(script, ctx.worktreePath, env, timeoutMs, signal)
}

function runScript(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  ranWith: string,
  signal: AbortSignal | undefined,
  onSettled?: () => void
): Promise<HookResult> {
  const { promise, resolve } = Promise.withResolvers<HookResult>()
  const child = spawn(command, args, { cwd, env, windowsHide: true })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (d) => (stdout += d.toString()))
  child.stderr?.on('data', (d) => (stderr += d.toString()))

  // The script is a shell, so whatever it launched is a grandchild. Killing
  // only the shell reaps the wrapper and leaves `npm test` running against a
  // worktree that is about to be deleted.
  const settle = (result: HookResult): void => {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    onSettled?.()
    resolve(result)
  }
  const stop = (note: string): void => {
    killProcessTree(child.pid)
    child.kill('SIGTERM')
    settle({ ok: false, exitCode: null, stdout, stderr: `${stderr}\n${note}`, ranWith })
  }
  const onAbort = (): void => stop('[stopped]')
  const timer = setTimeout(() => stop('[timed out]'), timeoutMs)

  if (signal?.aborted) {
    stop('[stopped]')
    return promise
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  child.on('exit', (code) => settle({ ok: code === 0, exitCode: code, stdout, stderr, ranWith }))
  child.on('error', (err) => settle({ ok: false, exitCode: null, stdout, stderr: `${stderr}\n${err.message}`, ranWith }))
  return promise
}

/** Fallback when bash is unavailable: write the script to a temp .cmd and run it. */
async function runViaCmd(
  script: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal: AbortSignal | undefined
): Promise<HookResult> {
  const tmp = join(tmpdir(), `conductor-hook-${Date.now()}.cmd`)
  try {
    await writeFile(tmp, '@echo off\n' + script, 'utf8')
  } catch (e) {
    // Without this the promise never settled and the caller waited forever.
    return { ok: false, exitCode: null, stdout: '', stderr: `could not write ${tmp}: ${String(e)}`, ranWith: 'cmd.exe' }
  }
  return runScript('cmd.exe', ['/d', '/c', tmp], cwd, env, timeoutMs, 'cmd.exe', signal, () => {
    void unlink(tmp).catch(() => {})
  })
}
