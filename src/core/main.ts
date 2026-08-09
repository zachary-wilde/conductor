// Headless entrypoint for the standalone Conductor Core process.
//
// Boots the full orchestration backend (store/sessions/ravel/roundtable/
// operations) behind the local control channel, guarded by a single-instance
// lock on the versioned data dir and fronted by a `/health` handshake + an
// endpoint hint file so an Electron client can discover and connect to it.
//
// Electron-free by design: the Core runs as a plain detached Node process that
// outlives the Electron window. `bootCore` is a factory (not a top-level side
// effect) so it is testable against a temp base + ephemeral ports.

import { createServer, type Server } from 'node:http'
import { chmodSync, writeFileSync, unlinkSync } from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { acquireLock, releaseLock, importLegacyStoreOnce, resolveCoreDataDir } from './data-dir'
import { createControlServer, type ControlServer } from './control-server'
import { createBackend, type CoreBackend } from './backend'

/** Thrown when a live Core already holds the lock for this data dir. */
export class CoreAlreadyRunning extends Error {
  constructor(dataDir: string) {
    super(`a Conductor Core already owns ${dataDir}`)
    this.name = 'CoreAlreadyRunning'
  }
}

export interface BootedCore {
  /** The loopback port of the `/health` handshake server. */
  port: number
  /** The loopback port of the control channel (backend RPC + event stream). */
  controlPort: number
  /** The Core-owned versioned data directory. */
  dataDir: string
  /** Stop the backend, close both servers, drop the endpoint hint, release the lock. */
  stop(): Promise<void>
}

export interface BootCoreOptions {
  /** Platform userData base; the Core owns `<base>/conductor-data/v2`. */
  base: string
  /** Health-server loopback port; 0 = ephemeral (tests). */
  port?: number
  /** Control-channel loopback port; 0 = ephemeral (tests). */
  controlPort?: number
  /** Loopback host; defaults to 127.0.0.1. */
  host?: string
  /** Version reported in the operations handshake. */
  version?: string
  /** Built web-client dir the Operations Core serves same-origin. */
  webStaticDir?: string
  /** Operations web-server port (LAN remote client); 0 = ephemeral. */
  webPort?: number
  /** Operations web-server host; 127.0.0.1 unless the LAN is opted into. */
  webHost?: string
  /** Bearer token for the remote operations API. */
  webToken?: string
  /** TLS override for the Operations web server; non-loopback defaults to TLS and refuses false. */
  webTls?: boolean
}

/**
 * Boot the Core: take the single-instance lock, import the legacy store once,
 * stand up the backend behind the control channel, and serve `/health`. Rejects
 * with {@link CoreAlreadyRunning} when a live Core already owns this data dir —
 * the caller should connect to that one instead of starting a second writer.
 */
export async function bootCore(options: BootCoreOptions): Promise<BootedCore> {
  const dataDir = resolveCoreDataDir(options.base)
  const lock = acquireLock(dataDir)
  if (!lock) throw new CoreAlreadyRunning(dataDir)

  let control: ControlServer | null = null
  let backend: CoreBackend | null = null
  const host = options.host ?? '127.0.0.1'
  const controlSecret = randomBytes(32).toString('hex')
  try {
    // The store (and every module that imports it) resolves its file here,
    // without Electron. Set before any backend handler touches the store.
    process.env.CONDUCTOR_DATA_DIR = dataDir
    importLegacyStoreOnce(options.base)

    backend = createBackend({
      dataDir,
      version: options.version ?? '0.0.0-core',
      webStaticDir: options.webStaticDir ?? join(dataDir, 'web'),
      webPort: options.webPort ?? 0,
      webHost: options.webHost ?? '127.0.0.1',
      webToken: options.webToken,
      webTls: options.webTls
    })
    control = await createControlServer({
      handlers: backend.handlers,
      secret: controlSecret,
      port: options.controlPort ?? 0,
      host
    })
    backend.bindEmit((channel, ...args) => control?.emit(channel, ...args))
    await backend.start()

    const controlPort = control.port
    const server = createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, pid: process.pid, dataDir, controlPort }))
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false }))
    })
    const port = await listen(server, options.port ?? 0, host)
    const endpointFile = join(dataDir, 'core-endpoint.json')
    writeEndpointHint(endpointFile, { port, controlPort, pid: process.pid, host, secret: controlSecret })

    const boundControl = control
    const boundBackend = backend
    return {
      port,
      controlPort,
      dataDir,
      stop: async () => {
        await boundBackend.stop()
        await boundControl.close()
        await stopHealth(server, endpointFile)
        releaseLock(lock)
      }
    }
  } catch (error) {
    if (control) await control.close()
    releaseLock(lock)
    throw error
  }
}

/** Resolve once the server is listening, to the actual bound port. */
function listen(server: Server, port: number, host: string): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>()
  server.once('error', reject)
  server.listen(port, host, () => {
    const address = server.address()
    if (address && typeof address === 'object') resolve(address.port)
    else reject(new Error('core health server bound to a non-inet address'))
  })
  return promise
}

/** Persist discovery data with owner-only mode where the platform supports it. */
function writeEndpointHint(endpointFile: string, hint: { port: number; controlPort: number; pid: number; host: string; secret: string }): void {
  writeFileSync(endpointFile, JSON.stringify(hint), { encoding: 'utf8', mode: 0o600 })
  try {
    // Windows chmod cannot express a full ACL; the endpoint is already under the
    // per-user data directory, so this remains best-effort there.
    chmodSync(endpointFile, 0o600)
  } catch {
    /* best-effort permission hardening */
  }
}

/** True for host spellings that bind only to the local machine. */
function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase()
  return normalized === 'localhost' || normalized === '::1' || (isIP(normalized) === 4 && normalized.startsWith('127.'))
}

function parseTlsOverride(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined
  if (value === '1') return true
  if (value === '0') return false
  console.warn(`[core] ignoring invalid CONDUCTOR_WEB_TLS=${JSON.stringify(value)}; using the safe default`)
  return undefined
}

/** Close the health server and drop the endpoint hint. */
async function stopHealth(server: Server, endpointFile: string): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  server.close(() => resolve())
  await promise
  try {
    unlinkSync(endpointFile)
  } catch {
    /* already gone */
  }
}
// Top-level entry: run when executed directly (not when imported by a test).
if (process.env.CONDUCTOR_CORE_ENTRY === '1') {
  process.on('unhandledRejection', (reason) => {
    console.error('[core] unhandled rejection', reason)
    process.exit(1)
  })
  process.on('uncaughtException', (error) => {
    console.error('[core] uncaught exception', error)
    process.exit(1)
  })

  const base = process.env.CONDUCTOR_CORE_BASE
  if (!base) {
    console.error('[core] CONDUCTOR_CORE_BASE is required to start the Core')
    process.exit(1)
  }
  const webHost = process.env.CONDUCTOR_WEB_HOST || '127.0.0.1'
  const loopback = isLoopbackHost(webHost)
  const webToken = process.env.CONDUCTOR_WEB_TOKEN || (loopback ? undefined : randomUUID())
  bootCore({
    base,
    port: Number(process.env.CONDUCTOR_CORE_PORT ?? 0),
    version: process.env.CONDUCTOR_CORE_VERSION,
    webStaticDir: process.env.CONDUCTOR_WEB_STATIC,
    webPort: Number(process.env.CONDUCTOR_WEB_PORT ?? 0),
    webHost,
    webToken,
    webTls: parseTlsOverride(process.env.CONDUCTOR_WEB_TLS)
  })
    .then((core) => {
      console.log(`[core] health ${core.port} · control ${core.controlPort} · ${core.dataDir}`)
      const shutdown = (): void => {
        void core.stop().finally(() => process.exit(0))
      }
      process.on('SIGINT', shutdown)
      process.on('SIGTERM', shutdown)
      process.on('SIGHUP', shutdown)
    })
    .catch((error) => {
      if (error instanceof CoreAlreadyRunning) {
        console.error(`[core] ${error.message}; exiting`)
        process.exit(3)
      }
      console.error('[core] failed to boot', error)
      process.exit(1)
    })
}
