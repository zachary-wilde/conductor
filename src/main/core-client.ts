// Electron-side client of the standalone Core's local control channel.
//
// Electron main is no longer the backend — it is a thin client. On boot it
// discovers a healthy Core via the endpoint hint file (+ /health), and if none
// is running it SPAWNS one DETACHED so the Core outlives the window. It then
// opens the control socket, correlates request/response by id, and forwards the
// Core's event pushes to whatever the renderer bridge registers.
//
// The Core is launched with Electron's own binary in Node mode
// (ELECTRON_RUN_AS_NODE) so no separate Node install is required; the versioned
// data dir, web-static path, and version ride along as env.

import { connect } from 'node:net'
import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  decodeFrames,
  encodeFrame,
  isAuthResponse,
  isEvent,
  isResponse,
  type ControlAuthRequest,
  type ControlResponse
} from '../core/control-protocol'
import { resolveCoreDataDir } from '../core/data-dir'

export const DEFAULT_CORE_RPC_TIMEOUT_MS = 30_000
const LONG_RUNNING_METHODS = new Set([
  'harness:detect',
  'harness:modelCatalogues',
  'merge:land',
  'ravel:approvePlan',
  'ravel:claimBrief',
  'ravel:create',
  'ravel:requestPlanChanges',
  'ravel:resume',
  'ravel:resumeInterruptedBrief',
  'ravel:retryCompilation',
  'ravel:sendMessage',
  'roundtable:start'
])

/** Resolve the diagnostic log path used by a freshly spawned Core. */
export function resolveCoreLogPath(base: string): string {
  return process.env.CONDUCTOR_CORE_LOG || join(resolveCoreDataDir(base), 'logs', 'core.log')
}

interface SpawnedCore {
  child: ChildProcess
  logPath: string
  error: Error | null
}

function readCoreLogTail(logPath: string, lineCount = 6): string | null {
  try {
    const lines = readFileSync(logPath, 'utf8').split(/\r?\n/).filter((line) => line.length > 0)
    return lines.length === 0 ? null : lines.slice(-lineCount).join('\n')
  } catch {
    return null
  }
}

function withCoreDiagnostics(error: unknown, spawned: SpawnedCore): Error {
  const diagnostics = [`Core log: ${spawned.logPath}`]
  const exitCode = spawned.child.exitCode
  if (exitCode !== null) diagnostics.push(`Core exit code: ${exitCode}`)
  if (spawned.child.signalCode) diagnostics.push(`Core signal: ${spawned.child.signalCode}`)
  if (spawned.error) diagnostics.push(`Core spawn error: ${spawned.error.message}`)
  const tail = readCoreLogTail(spawned.logPath)
  if (tail) diagnostics.push(`Last log lines:\n${tail}`)
  const message = error instanceof Error ? error.message : String(error)
  return new Error(`${message}\n${diagnostics.join('\n')}`)
}

export interface CoreClient {
  /** Invoke a backend method on the Core, resolving its result or rejecting its error. */
  call<T = unknown>(method: string, ...args: unknown[]): Promise<T>
  /** Register a listener for the Core's one-way event pushes (channel + args). */
  onEvent(listener: (channel: string, args: unknown[]) => void): void
  /** Register a listener fired once when the control socket drops (Core died/restarted). */
  onClose(listener: () => void): void
  /** Close the control socket (does NOT stop the Core — it keeps running). */
  close(): void
}

interface EndpointHint {
  port: number
  controlPort: number
  pid: number
  host: string
  secret: string
}

export interface ConnectOrSpawnOptions {
  /** Platform userData base (Electron `app.getPath('userData')`). */
  base: string
  /** Absolute path to the built Core entry (`out/core/main.js`). */
  coreEntry: string
  /** Electron binary to relaunch in Node mode; defaults to `process.execPath`. */
  execPath?: string
  /** Version + web-serving config forwarded to a freshly spawned Core. */
  version?: string
  webStaticDir?: string
  webHost?: string
  webToken?: string
  webPort?: number
  /** Max ms to wait for a freshly spawned Core to answer /health. */
  spawnTimeoutMs?: number
}

/** Read the endpoint hint written by a running Core, or null when absent/corrupt. */
function readEndpoint(dataDir: string): EndpointHint | null {
  const file = join(dataDir, 'core-endpoint.json')
  if (!existsSync(file)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    const hint = parsed as Partial<EndpointHint>
    if (
      typeof hint.port !== 'number' ||
      typeof hint.controlPort !== 'number' ||
      typeof hint.pid !== 'number' ||
      typeof hint.host !== 'string' ||
      typeof hint.secret !== 'string' ||
      hint.secret.length === 0
    ) return null
    return hint as EndpointHint
  } catch {
    return null
  }
}

/** True when a Core answers `/health` with `ok` at this endpoint. */
async function isHealthy(host: string, port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://${host}:${port}/health`)
    if (!res.ok) return false
    const body = (await res.json()) as { ok?: boolean }
    return body.ok === true
  } catch {
    return false
  }
}

const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

/**
 * Connect to a running Core, or spawn a detached one and connect to it. Returns
 * a {@link CoreClient} over the control channel. Throws if a freshly spawned
 * Core never becomes healthy within `spawnTimeoutMs`.
 */
export async function connectOrSpawnCore(options: ConnectOrSpawnOptions): Promise<CoreClient> {
  const dataDir = resolveCoreDataDir(options.base)
  const host = '127.0.0.1'

  let hint = readEndpoint(dataDir)
  if (!hint || !(await isHealthy(host, hint.port))) {
    const spawned = spawnDetachedCore(options)
    try {
      hint = await waitForHealthyCore(dataDir, host, options.spawnTimeoutMs ?? 15000, spawned)
    } catch (error) {
      throw withCoreDiagnostics(error, spawned)
    }
  }
  return openClient(host, hint.controlPort, hint.secret)
}

/** Launch the Core as a detached Node process so it survives Electron exit. */
function spawnDetachedCore(options: ConnectOrSpawnOptions): SpawnedCore {
  const logPath = resolveCoreLogPath(options.base)
  mkdirSync(dirname(logPath), { recursive: true })
  const out = openSync(logPath, 'a')
  let child: ChildProcess
  try {
    child = spawn(options.execPath ?? process.execPath, [options.coreEntry], {
      detached: true,
      stdio: ['ignore', out, out],
      windowsHide: true,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        CONDUCTOR_CORE_ENTRY: '1',
        CONDUCTOR_CORE_BASE: options.base,
        ...(options.version ? { CONDUCTOR_CORE_VERSION: options.version } : {}),
        ...(options.webStaticDir ? { CONDUCTOR_WEB_STATIC: options.webStaticDir } : {}),
        ...(options.webHost ? { CONDUCTOR_WEB_HOST: options.webHost } : {}),
        ...(options.webToken ? { CONDUCTOR_WEB_TOKEN: options.webToken } : {}),
        ...(options.webPort !== undefined ? { CONDUCTOR_WEB_PORT: String(options.webPort) } : {})
      }
    })
  } finally {
    closeSync(out)
  }
  const spawned: SpawnedCore = { child, logPath, error: null }
  child.once('error', (error) => {
    spawned.error = error
  })
  child.unref()
  return spawned
}

/** Poll for a freshly spawned Core to publish a healthy endpoint. */
async function waitForHealthyCore(
  dataDir: string,
  host: string,
  timeoutMs: number,
  spawned: SpawnedCore
): Promise<EndpointHint> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hint = readEndpoint(dataDir)
    if (hint && (await isHealthy(host, hint.port))) return hint
    if (spawned.error) throw new Error(`Core process failed to start: ${spawned.error.message}`)
    if (spawned.child.exitCode !== null) {
      throw new Error(`Core process exited with code ${spawned.child.exitCode}`)
    }
    await sleep(200)
  }
  throw new Error(`Conductor Core did not become healthy within ${timeoutMs}ms`)
}

/** Open the control socket and wire request/response correlation + event fan-in. */
export function openClient(
  host: string,
  controlPort: number,
  secret: string,
  rpcTimeoutMs = DEFAULT_CORE_RPC_TIMEOUT_MS
): Promise<CoreClient> {
  const { promise, resolve, reject } = Promise.withResolvers<CoreClient>()
  const socket = connect(controlPort, host)
  socket.setEncoding('utf8')

  let nextId = 1
  let authenticated = false
  const responders = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout?: NodeJS.Timeout }
  >()
  const listeners: ((channel: string, args: unknown[]) => void)[] = []
  const closeListeners: (() => void)[] = []
  let rest = ''
  const fail = (error: Error): void => {
    for (const pending of responders.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    responders.clear()
  }
  const client: CoreClient = {
    call<T>(method: string, ...args: unknown[]): Promise<T> {
      const id = nextId++
      const call = Promise.withResolvers<unknown>()
      const timeout = LONG_RUNNING_METHODS.has(method)
        ? undefined
        : setTimeout(() => {
            const pending = responders.get(id)
            if (!pending) return
            responders.delete(id)
            pending.reject(new Error(`control RPC "${method}" timed out after ${rpcTimeoutMs}ms`))
          }, rpcTimeoutMs)
      timeout?.unref()
      responders.set(id, { resolve: call.resolve, reject: call.reject, timeout })
      socket.write(encodeFrame({ id, method, args }))
      return call.promise as Promise<T>
    },
    onEvent(listener) {
      listeners.push(listener)
    },
    onClose(listener) {
      closeListeners.push(listener)
    },
    close() {
      socket.destroy()
    }
  }

  socket.on('data', (chunk: string) => {
    const decoded = decodeFrames(rest, chunk)
    rest = decoded.rest
    for (const frame of decoded.frames) {
      if (isAuthResponse(frame)) {
        if (!authenticated) {
          authenticated = true
          resolve(client)
        }
      } else if (!authenticated) {
        continue
      } else if (isResponse(frame)) {
        const pending = responders.get(frame.id)
        if (!pending) continue
        responders.delete(frame.id)
        clearTimeout(pending.timeout)
        if (frame.ok) pending.resolve(frame.value)
        else pending.reject(new Error(frame.error ?? 'core call failed'))
      } else if (isEvent(frame)) {
        for (const listener of listeners) listener(frame.channel, frame.args)
      }
    }
  })

  socket.on('error', (error) => {
    if (!authenticated) reject(error)
    fail(error)
  })
  socket.on('close', () => {
    const error = new Error('control channel closed')
    if (!authenticated) reject(error)
    fail(error)
    for (const listener of closeListeners) listener()
  })

  socket.once('connect', () => {
    socket.write(encodeFrame({ auth: secret } satisfies ControlAuthRequest))
  })

  return promise
}

// Re-export for callers that only need the response shape.
export type { ControlResponse }
