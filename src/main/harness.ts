import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { killProcessTree } from './proc'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import {
  HARNESS_INFO,
  HARNESS_MODEL_OPTIONS,
  type HarnessAvailability,
  type HarnessCatalogue,
  type HarnessId,
  type ResolvedHarness,
  type Settings
} from '@shared/types'

export type { HarnessCatalogue }

const execFileP = promisify(execFile)

/** Find the first existing file for a command name on Windows via `where`. */
async function where(name: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP('where.exe', [name], { windowsHide: true })
    const hits = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    return hits.find((p) => existsSync(p)) ?? null
  } catch {
    return null
  }
}

/**
 * Resolve a harness to a spawnable command.
 *
 * - `.exe` binaries (omp) launch directly via CreateProcess.
 * - `.cmd` shims (npm globals like claude/codex) must be launched through
 *   `cmd.exe /d /c <shim>` because CreateProcess cannot run .cmd files.
 */
function toSpawnable(id: HarnessId, found: string): ResolvedHarness {
  const lower = found.toLowerCase()
  if (lower.endsWith('.exe')) {
    return { id, command: found, args: [], resolvedFrom: found }
  }
  // .cmd / .bat / extensionless — route through cmd.exe.
  return {
    id,
    command: 'cmd.exe',
    args: ['/d', '/c', found],
    resolvedFrom: found
  }
}

/**
 * Resolve the user's shell for a terminal session, best first.
 *
 * PowerShell 7 if it is installed, then Windows PowerShell, then cmd. `cmd.exe`
 * is always present, so this never fails — a terminal session must not be able
 * to fail to launch the way an un-installed agent CLI can.
 *
 * `-NoLogo` suppresses the copyright banner that would otherwise be the first
 * thing in every new session.
 */
export async function resolveShell(): Promise<ResolvedHarness> {
  for (const [name, args] of [
    ['pwsh.exe', ['-NoLogo']],
    ['powershell.exe', ['-NoLogo']]
  ] as const) {
    const found = await where(name)
    if (found) return { id: null, command: found, args: [...args], resolvedFrom: found }
  }
  const comspec = process.env.ComSpec ?? 'cmd.exe'
  return { id: null, command: comspec, args: [], resolvedFrom: comspec }
}

/**
 * Environment variables that switch a harness CLI off its interactive login.
 *
 * Claude Code refuses the claude.ai session outright when it sees one: "connectors
 * are disabled because ANTHROPIC_API_KEY or another auth source is set and takes
 * precedence over your claude.ai login". Inheriting one from the user's
 * environment therefore does not merely fail — when the key IS valid it quietly
 * bills a metered API account instead of the subscription the operator is already
 * paying for, which is the opposite of "bring your own subscription".
 *
 * Only the child's copy is trimmed. The variable stays in the user's environment
 * for whatever else needs it.
 */
const CONFLICTING_AUTH: Record<HarnessId, readonly string[]> = {
  claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
  codex: [],
  zai: []
}

/**
 * The environment a harness child runs in.
 *
 * Returns the names it removed so the caller can say so once, rather than
 * leaving the operator to wonder why their key is being ignored.
 */
export function harnessEnv(
  id: HarnessId,
  base: NodeJS.ProcessEnv,
  extra?: Record<string, string>
): { env: Record<string, string>; stripped: string[] } {
  const env: Record<string, string> = { ...base, ...(extra ?? {}) } as Record<string, string>
  const stripped: string[] = []
  for (const name of CONFLICTING_AUTH[id]) {
    if (env[name] === undefined || env[name] === '') continue
    delete env[name]
    stripped.push(name)
  }
  return { env, stripped }
}

/**
 * Build the launch args for a harness, honoring user overrides and an optional
 * initial prompt (positional arg for all three CLIs).
 *
 * Model precedence: explicit per-session/brief override, then the harness
 * default from settings. An empty value leaves the CLI on its own default.
 */
export function buildLaunchArgs(
  id: HarnessId,
  settings: Settings,
  initialPrompt?: string,
  opts: { autoApprove?: boolean; model?: string | null } = {}
): string[] {
  const extra = settings.harnessArgs[id] ?? []
  const args: string[] = []
  const model = (opts.model ?? settings.harnessModels[id] ?? '').trim()
  if (model.length > 0) {
    args.push('--model', model)
  }
  args.push(...extra)
  // Children managed by Ravel run with full auto-approve so they never block
  // on permission gates. Only claude has a well-known flag; codex/zai are
  // left to their defaults in v1 (manager can still nudge them).
  if (opts.autoApprove && id === 'claude') {
    args.push('--dangerously-skip-permissions')
  }
  if (initialPrompt && initialPrompt.trim().length > 0) {
    args.push(initialPrompt)
  }
  return args
}

/**
 * Smoke-only escape hatch: when `CONDUCTOR_RAVEL_DUMMY_HARNESS` points at an
 * existing script, every harness resolves to it instead of a real CLI. It
 * covers all ids on purpose — a manual walkthrough must not be able to launch a
 * paid harness because a brief picked a different one.
 *
 * Prefers a real `node` binary and only falls back to `electron.exe` in Node
 * mode. Both execute the script identically, but electron.exe is a
 * GUI-subsystem image: under ConPTY it owns no console handles, so a child's
 * stdout is silently discarded and the pty never sees a byte. A test double
 * that cannot produce output cannot exercise anything that reads output.
 */
function dummyHarness(id: HarnessId): ResolvedHarness | null {
  const script = process.env.CONDUCTOR_RAVEL_DUMMY_HARNESS
  if (!script || !existsSync(script)) return null
  const node = consoleNodeBinary()
  return {
    id,
    command: node ?? process.execPath,
    args: [script],
    env: node ? {} : { ELECTRON_RUN_AS_NODE: '1' },
    resolvedFrom: script
  }
}

/** `node` beside the runner, or on PATH. Null when only Electron is available. */
function consoleNodeBinary(): string | null {
  const override = process.env.CONDUCTOR_RAVEL_DUMMY_NODE
  if (override && existsSync(override)) return override
  const name = process.platform === 'win32' ? 'node.exe' : 'node'
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, name)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Non-interactive invocation for one manager turn.
 *
 * The persistent-TUI transport was unreliable: pty output is ANSI redraw, so
 * fenced tool blocks were frequently unrecoverable. Each CLI has a print mode
 * that emits clean stdout for a single request, which is what the on-demand
 * manager uses.
 *
 * Prompt delivery differs per harness, and the difference is not cosmetic.
 * claude/codex are npm `.cmd` shims, so they launch through `cmd.exe /d /c`;
 * a multi-line argument cannot survive cmd.exe's command-line parsing, so
 * their prompt is piped on stdin (`claude -p` reads stdin, `codex exec -`
 * reads stdin -- both verified against the installed CLIs). omp is a real
 * `.exe` launched by CreateProcess, which passes newlines through untouched,
 * and it ignores stdin in print mode, so its prompt rides on argv.
 *
 * Model/reasoning and user args still apply. The interactive auto-approve flag
 * deliberately does not: a manager turn plans, it never edits. codex is pinned
 * to a read-only sandbox for the same reason; claude's print mode denies
 * permission-gated tools by default, and omp asks, which a headless run
 * refuses.
 */
export interface HeadlessInvocation {
  args: string[]
  /** Prompt to pipe on stdin, or null when it rides on argv. */
  stdin: string | null
}

export function buildHeadlessCommand(
  id: HarnessId,
  settings: Settings,
  prompt: string,
  opts: { model?: string | null } = {}
): HeadlessInvocation {
  const model = (opts.model ?? settings.harnessModels[id] ?? '').trim()
  const modelArgs = model.length > 0 ? ['--model', model] : []
  const extra = settings.harnessArgs[id] ?? []
  switch (id) {
    case 'claude':
      return { args: ['-p', ...modelArgs, ...extra], stdin: prompt }
    case 'codex':
      // --model belongs to `exec`, not the root command, so it follows the
      // subcommand; the trailing `-` tells codex to read the prompt from stdin.
      return { args: ['exec', ...modelArgs, '--sandbox', 'read-only', ...extra, '-'], stdin: prompt }
    case 'zai':
      return { args: ['-p', ...modelArgs, ...extra, prompt], stdin: null }
  }
}

/** A manager turn that has not produced output in this long is not going to. */
const HEADLESS_TIMEOUT_MS = 300_000
/** Enough for a verbose TUI-ish preamble; a runaway harness is not buffered forever. */
const HEADLESS_MAX_OUTPUT = 1_000_000

interface CaptureResult {
  /** null when the process was signalled rather than exiting on its own. */
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  aborted: boolean
}

/**
 * Spawn a CLI, capture bounded stdout/stderr, and always come back.
 *
 * A harness that hangs is the normal failure mode, not the exceptional one, so
 * the timeout kills the whole process tree rather than leaking an orphan
 * holding a pipe open. Only a failure to spawn throws; every other outcome is
 * reported in the result so callers can phrase their own error.
 */
async function spawnCapture(
  command: string,
  args: string[],
  opts: {
    cwd?: string
    env?: Record<string, string>
    stdin?: string | null
    timeoutMs: number
    maxOutput?: number
    signal?: AbortSignal
  }
): Promise<CaptureResult> {
  const limit = opts.maxOutput ?? HEADLESS_MAX_OUTPUT
  const child = spawn(command, args, {
    cwd: opts.cwd,
    windowsHide: true,
    // Already a complete environment when the caller built one with harnessEnv;
    // spreading process.env again here would put the stripped keys straight back.
    env: opts.env ?? (process.env as Record<string, string>),
    stdio: ['pipe', 'pipe', 'pipe']
  })

  let stdout = ''
  let stderr = ''
  let timedOut = false
  const capture = (buffer: string, chunk: Buffer): string =>
    buffer.length >= limit ? buffer : (buffer + chunk.toString('utf8')).slice(0, limit)
  child.stdout.on('data', (chunk: Buffer) => {
    stdout = capture(stdout, chunk)
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = capture(stderr, chunk)
  })

  let aborted = opts.signal?.aborted === true
  const stop = (): void => {
    killProcessTree(child.pid)
    child.kill('SIGKILL')
  }
  const onAbort = (): void => {
    aborted = true
    stop()
  }
  opts.signal?.addEventListener('abort', onAbort, { once: true })
  if (aborted) stop()

  const timer = setTimeout(() => {
    timedOut = true
    stop()
  }, opts.timeoutMs)

  const stdin = opts.stdin ?? null
  if (stdin === null) {
    child.stdin.end()
  } else {
    child.stdin.on('error', () => {
      /* the harness closed stdin early; the exit code is the real signal */
    })
    child.stdin.end(stdin, 'utf8')
  }

  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    return { code, stdout, stderr, timedOut, aborted }
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * Run one non-interactive turn and return its stdout.
 *
 * Failures throw with a trimmed stderr tail so the caller can surface a visible
 * turn error instead of silently producing no tool calls. `signal` exists so a
 * Ravel being deleted or paused does not have to wait out a five-minute turn.
 */
export async function runHeadlessHarness(
  id: HarnessId,
  settings: Settings,
  prompt: string,
  opts: { model?: string | null; cwd?: string; timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<string> {
  const resolved = await resolveHarness(id, settings)
  const invocation = buildHeadlessCommand(id, settings, prompt, { model: opts.model })
  const { env, stripped } = harnessEnv(id, process.env, resolved.env)
  if (stripped.length > 0) {
    console.log(`[conductor] ${id}: using its own login; ignored ${stripped.join(', ')} from the environment`)
  }
  const run = await spawnCapture(resolved.command, [...resolved.args, ...invocation.args], {
    cwd: opts.cwd,
    env,
    stdin: invocation.stdin,
    timeoutMs: opts.timeoutMs ?? HEADLESS_TIMEOUT_MS,
    signal: opts.signal
  })
  if (run.timedOut) throw new Error(`${HARNESS_INFO[id].label} headless turn timed out`)
  if (run.aborted) throw new Error(`${HARNESS_INFO[id].label} headless turn was cancelled`)
  if (run.code !== 0) {
    const detail = (run.stderr.trim() || run.stdout.trim()).slice(-400)
    throw new Error(`${HARNESS_INFO[id].label} headless turn exited ${run.code}${detail ? `: ${detail}` : ''}`)
  }
  return run.stdout
}

/**
 * Concurrent on purpose: this runs inside the renderer's startup batch, so the
 * app is not interactive until it resolves. Three sequential `where.exe`
 * spawns cost roughly three times one, for lookups that have nothing to do
 * with each other.
 */
export async function detectHarnesses(settings: Settings): Promise<HarnessAvailability[]> {
  return Promise.all(
    (Object.keys(HARNESS_INFO) as HarnessId[]).map(async (id) => {
      const info = HARNESS_INFO[id]
      const dummy = dummyHarness(id)
      if (dummy) return { id, info, available: true, resolved: dummy }

      const lookupName = id === 'zai' ? 'omp' : id
      const override = settings.harnessPaths[id]
      const found = (override && existsSync(override) ? override : null) ?? (await where(lookupName))
      if (!found) return { id, info, available: false, reason: `${lookupName} not found on PATH` }
      return { id, info, available: true, resolved: toSpawnable(id, found) }
    })
  )
}

/** Resolve a single harness using current settings (for session spawn). */
export async function resolveHarness(
  id: HarnessId,
  settings: Settings
): Promise<ResolvedHarness> {
  const all = await detectHarnesses(settings)
  const hit = all.find((h) => h.id === id)
  if (!hit || !hit.available || !hit.resolved) {
    const name = id === 'zai' ? 'omp' : id
    throw new Error(
      `${HARNESS_INFO[id].label} is not available. Install it or set a custom path in Settings (looked for "${name}").`
    )
  }
  return hit.resolved
}

/** How one harness is asked what models it supports. `null` means it cannot be. */
interface CatalogueProbe {
  /** Appended to the resolved harness command. Must be non-interactive. */
  args: string[]
  parse: (stdout: string) => string[]
}

/**
 * Live model enumeration, per harness.
 *
 * `HARNESS_MODEL_OPTIONS` is hand-written and goes stale on every vendor
 * release, which reads as a broken dropdown. Where a CLI can be asked, it is.
 *
 * - **codex** — `codex debug models` prints the raw catalogue as JSON.
 * - **zai (omp)** — `omp models --json` prints the resolved catalogue as JSON,
 *   with `selector` already in the `provider/model` form omp's `--model` wants.
 * - **claude** — no mechanism exists. Claude Code registers no model
 *   subcommand; `/model` is a slash command inside the TUI and `--model` only
 *   documents aliases in its help text. Probing it means either starting a
 *   session (which spends quota) or parsing prose, so it stays on the static
 *   list until Anthropic ships a listing command.
 */
const CATALOGUE_PROBES: Record<HarnessId, CatalogueProbe | null> = {
  claude: null,
  codex: { args: ['debug', 'models'], parse: parseCodexCatalogue },
  zai: { args: ['models', '--json'], parse: parseOmpCatalogue }
}

/**
 * A catalogue dump is a local read with no model call behind it, so anything
 * slower than this is a CLI that has decided to do something else — log in,
 * self-update, prompt. The dropdown is not worth waiting on either way.
 */
const CATALOGUE_TIMEOUT_MS = 6_000
/** Full omp catalogues run past 100 KB of JSON; a runaway is still bounded. */
const CATALOGUE_MAX_OUTPUT = 4_000_000
/** A dropdown past this is unusable anyway, and the memory is not free. */
const CATALOGUE_MAX_MODELS = 500

function staticCatalogue(id: HarnessId): HarnessCatalogue {
  return { models: HARNESS_MODEL_OPTIONS[id], discovered: false }
}

/**
 * Pull the JSON body out of a CLI's stdout.
 *
 * Slicing to the outermost braces tolerates a version banner or an update
 * notice printed ahead of the payload, which every one of these CLIs does at
 * some point in its life.
 */
function parseJsonPayload(stdout: string): Record<string, unknown> | null {
  const start = stdout.indexOf('{')
  const end = stdout.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed: unknown = JSON.parse(stdout.slice(start, end + 1))
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function catalogueEntries(stdout: string): Record<string, unknown>[] {
  const models = parseJsonPayload(stdout)?.models
  if (!Array.isArray(models)) return []
  return models.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
}

/** `visibility: "hide"` marks entries codex itself will not offer. */
function parseCodexCatalogue(stdout: string): string[] {
  return catalogueEntries(stdout)
    .filter((entry) => entry.visibility !== 'hide')
    .map((entry) => entry.slug)
    .filter((slug): slug is string => typeof slug === 'string' && slug.length > 0)
}

/** `selector` is the fully-qualified `provider/model` id, which is what omp accepts. */
function parseOmpCatalogue(stdout: string): string[] {
  return catalogueEntries(stdout)
    .map((entry) => entry.selector)
    .filter((selector): selector is string => typeof selector === 'string' && selector.length > 0)
}

async function discoverCatalogue(
  id: HarnessId,
  settings: Settings,
  timeoutMs: number
): Promise<HarnessCatalogue> {
  const probe = CATALOGUE_PROBES[id]
  if (probe === null) return staticCatalogue(id)

  let resolved: ResolvedHarness
  try {
    resolved = await resolveHarness(id, settings)
  } catch {
    return staticCatalogue(id)
  }

  const run = await spawnCapture(resolved.command, [...resolved.args, ...probe.args], {
    env: harnessEnv(id, process.env, resolved.env).env,
    timeoutMs,
    maxOutput: CATALOGUE_MAX_OUTPUT
  })
  if (run.timedOut || run.code !== 0) return staticCatalogue(id)

  const models = [...new Set(probe.parse(run.stdout))].slice(0, CATALOGUE_MAX_MODELS)
  // An empty parse is indistinguishable from a CLI that changed its output
  // shape, and an empty dropdown is worse than a stale one.
  return models.length === 0 ? staticCatalogue(id) : { models, discovered: true }
}

/**
 * Cached for the process lifetime, keyed on harness alone. A vendor's catalogue
 * does not move within one app session, and re-probing on every dropdown render
 * would spawn a process per keystroke. The consequence is that changing a
 * harness path in Settings needs a restart to re-enumerate; the fallback list
 * still covers the interim.
 *
 * The pending promise is what gets cached, so concurrent callers share one
 * subprocess instead of racing several.
 */
const catalogueCache = new Map<HarnessId, Promise<HarnessCatalogue>>()

/**
 * Models the installed CLI reports, or the static fallback.
 *
 * Never rejects and never runs longer than the probe timeout: a missing,
 * broken, or hanging CLI degrades to `HARNESS_MODEL_OPTIONS` rather than
 * leaving the caller without a list.
 */
export function resolveModelCatalogue(
  id: HarnessId,
  settings: Settings,
  opts: { timeoutMs?: number } = {}
): Promise<HarnessCatalogue> {
  const cached = catalogueCache.get(id)
  if (cached !== undefined) return cached
  const pending = discoverCatalogue(id, settings, opts.timeoutMs ?? CATALOGUE_TIMEOUT_MS).catch(() =>
    staticCatalogue(id)
  )
  catalogueCache.set(id, pending)
  return pending
}

/** Every harness at once; probes run concurrently because none depends on another. */
export async function resolveModelCatalogues(
  settings: Settings,
  opts: { timeoutMs?: number } = {}
): Promise<Record<HarnessId, HarnessCatalogue>> {
  const ids = Object.keys(HARNESS_INFO) as HarnessId[]
  const resolved = await Promise.all(ids.map((id) => resolveModelCatalogue(id, settings, opts)))
  return Object.fromEntries(ids.map((id, index) => [id, resolved[index]])) as Record<HarnessId, HarnessCatalogue>
}

/** Drops the memoised catalogues. Exists so tests can probe more than once. */
export function resetModelCatalogueCache(): void {
  catalogueCache.clear()
}
