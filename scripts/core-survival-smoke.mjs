/**
 * Survival smoke for the standalone Conductor Core.
 *
 * Proves the Release-A promise that "active work, timers, controls, and
 * evidence continue with the Electron window closed and remain coherent after
 * reconnect": launch the built Electron app (which spawns a DETACHED Core),
 * create a live terminal session through the Core, KILL Electron, then assert
 * the Core process and the session are still alive and queryable — and that a
 * relaunched Electron RECONNECTS to the same Core rather than starting another.
 *
 * Talks to the Core directly over its local control channel (line-delimited
 * JSON), so it needs no renderer/CDP. Exit 0 = survived; 1 = a real regression;
 * 2 = harness/setup fault.
 *
 * Usage: node scripts/core-survival-smoke.mjs
 */
import { spawn, execFileSync } from 'node:child_process'
import { connect } from 'node:net'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DUMMY = join(ROOT, 'scripts', 'ravel-dummy-harness.mjs')
const require = createRequire(import.meta.url)

const base = mkdtempSync(join(tmpdir(), 'core-survival-'))
const repoDir = join(base, 'repo')
const endpointFile = join(base, 'conductor-data', 'v2', 'core-endpoint.json')

let failed = 0
const results = []
function check(label, ok, detail = '') {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        ${detail}`}`)
  if (!ok) failed += 1
}
function fail(message) {
  process.stderr.write(`${message}\n`)
  cleanup()
  process.exit(2)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function electronBinary() {
  const path = require('electron')
  if (typeof path !== 'string' || !existsSync(path)) fail('cannot locate the electron binary — run `npm install`')
  return path
}

function launchElectron() {
  return spawn(electronBinary(), ['.'], {
    cwd: ROOT,
    env: {
      ...process.env,
      CONDUCTOR_SMOKE_USER_DATA: base,
      CONDUCTOR_RAVEL_DUMMY_HARNESS: DUMMY
    },
    stdio: 'ignore'
  })
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

function killTree(pid) {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
    else process.kill(pid, 'SIGKILL')
  } catch {
    /* already gone */
  }
}

/** Kill ONE process, not its tree. Used to close Electron without reaping the
 *  detached Core: on Windows the Core is a descendant of Electron, so
 *  `taskkill /T` (killTree) would take it down too. Closing only the main
 *  Electron process reaps its own helper processes (via Electron's job object)
 *  while leaving the detached Core — and the work it owns — alive. */
function killProcess(pid) {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(pid), '/F'], { stdio: 'ignore' })
    else process.kill(pid, 'SIGKILL')
  } catch {
    /* already gone */
  }
}

async function waitFor(predicate, description, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await sleep(200)
  }
  fail(`timed out waiting for ${description}`)
}

function readEndpoint() {
  if (!existsSync(endpointFile)) return null
  try {
    return JSON.parse(readFileSync(endpointFile, 'utf8'))
  } catch {
    return null
  }
}

/** A minimal authenticated control-channel client for line-delimited JSON calls. */
function controlClient(port, secret) {
  const socket = connect(port, '127.0.0.1')
  socket.setEncoding('utf8')
  const responders = new Map()
  let nextId = 1
  let rest = ''
  let authenticated = false
  const ready = new Promise((res, rej) => {
    socket.once('connect', () => socket.write(JSON.stringify({ auth: secret }) + '\n'))
    socket.once('error', rej)
    socket.on('data', (chunk) => {
      const parts = (rest + chunk).split('\n')
      rest = parts.pop() ?? ''
      for (const part of parts) {
        if (!part) continue
        const frame = JSON.parse(part)
        if (frame.auth === true && frame.ok === true) {
          authenticated = true
          res()
          continue
        }
        if (authenticated && typeof frame.id === 'number' && responders.has(frame.id)) {
          const { resolve: resolveCall, reject } = responders.get(frame.id)
          responders.delete(frame.id)
          frame.ok ? resolveCall(frame.value) : reject(new Error(frame.error ?? 'call failed'))
        }
      }
    })
  })
  return {
    ready,
    call(method, ...args) {
      const id = nextId++
      return new Promise((res, rej) => {
        responders.set(id, { resolve: res, reject: rej })
        socket.write(JSON.stringify({ id, method, args }) + '\n')
      })
    },
    close: () => socket.destroy()
  }
}
/** Open an authenticated control client, retrying a just-spawned Core that is not yet accepting. */
async function openControl(port, secret) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const client = controlClient(port, secret)
    try {
      await client.ready
      return client
    } catch {
      client.close()
      await sleep(200)
    }
  }
  fail(`could not connect to the Core control channel on ${port}`)
}

let electron = null
let cleaned = false
function cleanup() {
  if (cleaned) return
  cleaned = true
  const ep = readEndpoint()
  if (ep?.pid) killTree(ep.pid)
  if (electron) killTree(electron.pid)
  try {
    rmSync(base, { recursive: true, force: true })
  } catch {
    /* the Core may still hold a handle briefly */
  }
}


async function main() {
  mkdirSync(repoDir, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: repoDir })
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repoDir })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repoDir })

  // 1. Launch Electron; it spawns the detached Core.
  electron = launchElectron()
  const ep1 = await waitFor(readEndpoint, 'the Core to publish its endpoint')
  const corePid = ep1.pid
  check('Electron spawned a Core with a live pid', pidAlive(corePid), `pid ${corePid}`)

  // 2. Create a live terminal session through the Core's control channel.
  const client1 = await openControl(ep1.controlPort, ep1.secret)
  const repo = await client1.call('repo:add', repoDir)
  const session = await client1.call('session:create', {
    repoId: repo.id,
    repoPath: repoDir,
    worktreePath: repoDir,
    branch: 'main',
    harness: null,
    kind: 'normal'
  })
  const before = await client1.call('session:list')
  check('a live session exists before the window closes', before.some((s) => s.id === session.id), `sessions: ${before.length}`)
  client1.close()

  // 3. Kill Electron ONLY. The detached Core is a descendant of Electron on
  //    Windows, so a tree kill (taskkill /T) would reap it too — kill just the
  //    main process so the Core (and its sessions) survive the window closing.
  killProcess(electron.pid)
  electron = null
  await sleep(1500)

  // 4. The Core and the session must have survived the window closing.
  check('the Core process outlived Electron', pidAlive(corePid), `pid ${corePid}`)
  const health = await fetch(`http://127.0.0.1:${ep1.port}/health`).then((r) => r.json()).catch(() => null)
  check('the Core still serves /health after the window closed', health?.ok === true, JSON.stringify(health))

  const client2 = await openControl(ep1.controlPort, ep1.secret)
  const after = await client2.call('session:list')
  check('the session is still live in the Core after the window closed', after.some((s) => s.id === session.id), `sessions: ${after.length}`)
  const repos = await client2.call('repo:list')
  check('durable state (the added repo) survived the window closing', repos.some((r) => r.id === repo.id), `repos: ${repos.length}`)
  client2.close()

  // 5. A relaunched Electron must RECONNECT to the same Core, not spawn another.
  electron = launchElectron()
  const ep2 = await waitFor(() => {
    const ep = readEndpoint()
    return ep && pidAlive(ep.pid) ? ep : null
  }, 'the relaunched Electron to have a healthy Core')
  check('the relaunched window reconnected to the SAME Core', ep2.pid === corePid, `before ${corePid}, after ${ep2.pid}`)

  cleanup()
  process.stdout.write(results.join('\n') + '\n')
  process.stdout.write(`${results.length - failed}/${results.length} survival checks passed\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  fail(`survival smoke crashed: ${e?.stack ?? e}`)
})

// The Core is detached, so a stuck smoke would hang CI forever waiting on a
// socket that never connects. Fail loudly past this ceiling instead. unref'd so
// it never keeps an otherwise-finished process alive.
const watchdog = setTimeout(() => fail('survival smoke timed out'), 90_000)
watchdog.unref()
// A detached Core outlives this script, so clean it up on interrupt too.
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => fail(`received ${sig}`))
