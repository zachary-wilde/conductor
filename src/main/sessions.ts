import * as pty from 'node-pty'
import { basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { killProcessTree } from './proc'
import {
  HARNESS_INFO,
  type CreateSessionRequest,
  type HarnessId,
  type ResolvedHarness,
  type Session,
  type SessionStatus,
  type Settings
} from '@shared/types'
import { buildLaunchArgs, harnessEnv, resolveHarness, resolveShell } from './harness'
import type { InsightTrigger } from './insights/types'
import { SessionOutput } from './output-meter'

const IDLE_MS_TO_NEEDS_INPUT = 15_000

/** Announce accrued output roughly every this many cleaned characters. */
const PROGRESS_REPORT_CHARS = 1_000

/** What a finished session is worth to its owner. */
export interface SessionExitResult {
  exitCode: number
  /** Cleaned output characters — see SessionOutput, not raw pty bytes. */
  outputChars: number
  /** Trailing screen text, for callers that need a last word. */
  tail: string
}

export interface SessionEvents {
  /** Stream a chunk of pty output to the renderer. */
  data: (sessionId: string, data: string) => void
  /**
   * A pty was spawned and is now in `listSessions()`. Distinct from the first
   * `status` change, which only fires once the child writes something — services
   * that must arm on the existence of a session cannot wait for that.
   */
  created: (session: Session) => void
  /** Process exited. */
  exit: (sessionId: string, result: SessionExitResult) => void
  /** Status changed (running / needs-input / closed / error). */
  status: (sessionId: string, status: SessionStatus) => void
  /**
   * Output accrued while the session is still alive, in cleaned characters
   * since the last announcement. A ceiling that only settles at exit cannot
   * stop a runaway child, so spend has to be observable in flight.
   */
  progress: (sessionId: string, deltaChars: number) => void
}

interface Runtime {
  session: Session
  pty: pty.IPty
  idleTimer: NodeJS.Timeout | undefined
  gotData: boolean
  /** Cleaned screen text, for usage estimation and the report fallback. */
  output: SessionOutput
  /** Characters already announced through `progress`. */
  reportedChars: number
}

const runtimes = new Map<string, Runtime>()

let events: SessionEvents = {
  data: () => {},
  created: () => {},
  exit: () => {},
  status: () => {},
  progress: () => {}
}

export function setSessionEvents(e: SessionEvents): void {
  events = e
}

/**
 * Injected so this module never imports the insight coordinator. Ravel children
 * carry their `ravelId`; a plain session belongs to no ravel and is not worth an
 * evaluation pass, so it is skipped rather than sent under a fake id.
 *
 * Wrapped because a notifier is foreign code on the status path: an observer that
 * throws must never stop a session from reporting that it changed state.
 */
let insightNotifier: (trigger: InsightTrigger, ravelId: string) => void = () => {}

export function setInsightNotifier(fn: (trigger: InsightTrigger, ravelId: string) => void): void {
  insightNotifier = fn
}

function setStatus(rt: Runtime, status: SessionStatus): void {
  if (rt.session.status === status) return
  rt.session.status = status
  rt.session.lastActivityAt = Date.now()
  events.status(rt.session.id, status)
  if (rt.session.kind !== 'ravel-child') return
  try {
    insightNotifier('session-status', rt.session.ravelId)
  } catch (e) {
    console.error('[conductor] insight notifier failed for session-status:', e)
  }
}

function armIdleTimer(rt: Runtime): void {
  clearTimeout(rt.idleTimer)
  rt.idleTimer = setTimeout(() => {
    if (rt.session.status === 'running') setStatus(rt, 'needs-input')
  }, IDLE_MS_TO_NEEDS_INPUT)
}

/** Quote one argument for the Windows cmd wrapper used to select UTF-8 code page. */
function quoteCmdArg(arg: string): string {
  if (/^[A-Za-z0-9_./\\:-]+$/.test(arg)) return arg
  return `"${arg.replace(/(["^])/g, '^$1')}"`
}

/**
 * ConPTY inherits the Windows console code page, which can remain CP437 even
 * when LANG/LC_* advertise UTF-8. Set CP65001 before launching the real
 * command so TUIs choose Unicode borders rather than ASCII fallbacks.
 */
function preparePtyLaunch(agent: HarnessId | null, resolved: ResolvedHarness, args: string[]): { command: string; args: string[] } {
  const commandArgs = [...resolved.args, ...args]
  // Keep agent PTYs direct: interactive CLIs rely on raw-mode input, which a
  // cmd.exe code-page wrapper would buffer before forwarding.
  if (process.platform !== 'win32' || agent !== null) return { command: resolved.command, args: commandArgs }
  const command = [basename(resolved.command), ...commandArgs].map(quoteCmdArg).join(' ')
  return {
    command: process.env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/c', `chcp 65001>nul & ${command}`]
  }
}

function spawnPty(
  agent: HarnessId | null,
  resolved: ResolvedHarness,
  args: string[],
  cwd: string,
  env?: Record<string, string>
): pty.IPty {
  // A terminal runs the operator's own shell, so its environment is left exactly
  // as they have it; only an agent CLI gets its conflicting auth trimmed.
  const base = { ...process.env, TERM: 'xterm-256color', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', LC_CTYPE: 'en_US.UTF-8' } as NodeJS.ProcessEnv
  const extra = { ...(resolved.env ?? {}), ...(env ?? {}) }
  const prepared =
    agent === null
      ? { env: { ...base, ...extra } as Record<string, string>, stripped: [] as string[] }
      : harnessEnv(agent, base, extra)
  if (prepared.stripped.length > 0) {
    console.log(
      `[conductor] ${agent}: using its own login; ignored ${prepared.stripped.join(', ')} from the environment`
    )
  }
  const launch = preparePtyLaunch(agent, resolved, args)
  return pty.spawn(launch.command, launch.args, {
    name: 'xterm-256color',
    cols: 100,
    rows: 28,
    cwd,
    env: prepared.env,
    useConpty: true
  })
}

export async function createSession(req: CreateSessionRequest, settings: Settings): Promise<Session> {
  // A terminal session runs the operator's shell. It takes no model, no
  // auto-approve flag and no prompt argument — a shell would treat the prompt as
  // a command to execute, which is not what anyone means by "initial prompt".
  const agent = req.harness
  const resolved = agent === null ? await resolveShell() : await resolveHarness(agent, settings)
  const extraArgs =
    agent === null
      ? []
      : buildLaunchArgs(agent, settings, req.initialPrompt ?? undefined, {
          autoApprove: req.autoApprove,
          model: req.model ?? null
        })
  const id = randomUUID()
  const now = Date.now()
  const base = {
    id,
    repoId: req.repoId,
    repoPath: req.repoPath,
    worktreePath: req.worktreePath,
    branch: req.branch,
    status: 'starting' as const,
    title: req.title?.trim() || (req.initialPrompt ? truncate(req.initialPrompt, 60) : null),
    initialPrompt: agent === null ? null : (req.initialPrompt ?? null),
    createdAt: now,
    lastActivityAt: now
  }
  const session: Session =
    req.kind === 'ravel-child'
      ? {
          ...base,
          kind: 'ravel-child',
          harness: req.harness,
          parentId: null,
          ravelId: req.ravelId,
          ravelRole: req.ravelRole,
          briefId: req.briefId
        }
      : {
          ...base,
          kind: 'normal',
          harness: req.harness,
          parentId: null,
          ravelId: null,
          ravelRole: null,
          briefId: null
        }

  const p = spawnPty(agent, resolved, extraArgs, req.worktreePath, req.env)
  const rt: Runtime = {
    session,
    pty: p,
    idleTimer: undefined,
    gotData: false,
    output: new SessionOutput(),
    reportedChars: 0
  }

  p.onData((chunk) => {
    rt.output.push(chunk)
    rt.gotData = true
    session.lastActivityAt = Date.now()
    if (session.status === 'starting' || session.status === 'needs-input') {
      setStatus(rt, 'running')
    }
    armIdleTimer(rt)
    events.data(id, chunk)
    // Throttled: a per-chunk announcement would bill through the IPC bridge on
    // every keystroke of redraw for no extra accuracy.
    const unreported = rt.output.chars - rt.reportedChars
    if (unreported >= PROGRESS_REPORT_CHARS) {
      rt.reportedChars = rt.output.chars
      events.progress(id, unreported)
    }
  })

  p.onExit(({ exitCode }) => {
    clearTimeout(rt.idleTimer)
    setStatus(rt, exitCode === 0 ? 'closed' : 'error')
    // Must run before the runtime is dropped; the owner needs the final count.
    events.exit(id, { exitCode, outputChars: rt.output.chars, tail: rt.output.tail })
    runtimes.delete(id)
  })

  runtimes.set(id, rt)
  events.created(session)
  return session
}

export function getSession(id: string): Session | undefined {
  return runtimes.get(id)?.session
}

export function listSessions(): Session[] {
  return Array.from(runtimes.values()).map((r) => r.session)
}

export function writeToSession(id: string, data: string): boolean {
  const rt = runtimes.get(id)
  if (!rt) return false
  rt.pty.write(data)
  return true
}

export function resizeSession(id: string, cols: number, rows: number): boolean {
  const rt = runtimes.get(id)
  if (!rt) return false
  try {
    rt.pty.resize(Math.max(1, cols | 0), Math.max(1, rows | 0))
    return true
  } catch {
    return false
  }
}


export function killSession(id: string): boolean {
  const rt = runtimes.get(id)
  if (!rt) return false
  killProcessTree(rt.pty.pid)
  try {
    rt.pty.kill()
  } catch {
    /* already gone */
  }
  return true
}

/**
 * Promote a live ravel-child session to a standalone `normal` session, keeping
 * its pty/process and worktree untouched. Used by Ravel `detach`: the operator
 * takes over the running agent, so it stops being the ravel's child (its
 * ravelId/role/brief are cleared) and becomes an ordinary session in the
 * sessions rail. Returns the updated session, or undefined when unknown or when
 * it was not a ravel child.
 */
export function promoteToStandalone(id: string): Session | undefined {
  const rt = runtimes.get(id)
  if (!rt || rt.session.kind !== 'ravel-child') return undefined
  rt.session = {
    ...rt.session,
    kind: 'normal',
    parentId: null,
    ravelId: null,
    ravelRole: null,
    briefId: null
  }
  rt.session.lastActivityAt = Date.now()
  return rt.session
}

export function killAllSessions(): void {
  for (const id of Array.from(runtimes.keys())) killSession(id)
}

function truncate(s: string, n: number): string {
  const t = s.trim().replace(/\s+/g, ' ')
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

export function harnessLabel(id: HarnessId): string {
  return HARNESS_INFO[id].label
}
