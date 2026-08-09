/**
 * Where does Conductor's startup time actually go?
 *
 * Timestamps every phase from process spawn to an interactive shell, then
 * measures each startup IPC call on its own so the dominant cost is a fact
 * rather than a guess.
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCRATCH = join(ROOT, '.tmp', 'startup-profile')
const USER_DATA = join(SCRATCH, 'user-data')
const port = 9231
const cold = process.argv.includes('--cold')

if (cold) rmSync(SCRATCH, { recursive: true, force: true })
mkdirSync(USER_DATA, { recursive: true })

// A copy of the operator's real store, never the original: startup cost scales
// with what is actually in it, and an empty store measures nothing useful.
if (process.argv.includes('--seed')) {
  const real = join(process.env.APPDATA ?? '', 'conductor', 'conductor-data', 'store.json')
  if (!existsSync(real)) throw new Error(`no real store at ${real}`)
  mkdirSync(join(USER_DATA, 'conductor-data'), { recursive: true })
  writeFileSync(join(USER_DATA, 'conductor-data', 'store.json'), readFileSync(real, 'utf8'), 'utf8')
  process.stdout.write(`seeded from ${real} (${Math.round(readFileSync(real, 'utf8').length / 1024)}KB)\n`)
}

const require = createRequire(import.meta.url)
const electronBinary = require('electron')

const t0 = Date.now()
const marks = []
function mark(label) {
  marks.push({ label, ms: Date.now() - t0 })
}

const child = spawn(electronBinary, ['.', `--remote-debugging-port=${port}`], {
  cwd: ROOT,
  env: { ...process.env, CONDUCTOR_SMOKE_USER_DATA: USER_DATA },
  stdio: ['ignore', 'pipe', 'pipe']
})
let sawFirstOutput = false
const onOut = (d) => {
  const text = String(d)
  if (!sawFirstOutput) {
    sawFirstOutput = true
    mark('main process alive (first stdout)')
  }
  if (text.includes('renderer loaded')) mark('renderer did-finish-load')
  if (text.includes('[conductor:startup] ready-to-show')) mark('window shown (ready-to-show)')
}
child.stdout.on('data', onOut)
child.stderr.on('data', onOut)

async function targetUrl() {
  for (let i = 0; i < 300; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page.webSocketDebuggerUrl
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('no renderer target')
}

const ws = await targetUrl()
mark('CDP page target available')

const socket = new WebSocket(ws)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
let nextId = 1
const pending = new Map()
socket.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  const entry = pending.get(msg.id)
  if (!entry) return
  pending.delete(msg.id)
  if (msg.error) entry.reject(new Error(msg.error.message))
  else entry.resolve(msg.result)
})
function send(method, params) {
  const id = nextId++
  socket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}
async function evaluate(expression) {
  const res = await send('Runtime.evaluate', {
    expression: `(async () => { ${expression} })()`,
    awaitPromise: true,
    returnByValue: true
  })
  if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails.exception ?? {}))
  return res.result.value
}

// Wait for the shell to actually exist, which is what "open" means to a user.
//
// This waits on `[data-startup-ready]` — a stable marker on App's root element — rather
// than a visible label. It used to look for `aside[aria-label="Projects"]`, which stopped
// existing when the dashboard became GlassShell; the loop then timed out and reported
// success anyway, producing a fake 37-second reading. A profiler that lies is worse than
// no profiler, so this now throws instead.
let shellReady = false
for (let i = 0; i < 600; i += 1) {
  shellReady = await evaluate(`return !!document.querySelector('[data-startup-ready]')`)
  if (shellReady) break
  await new Promise((r) => setTimeout(r, 50))
}
if (!shellReady) throw new Error('renderer never committed its startup shell')
mark('React shell committed')

const nav = await evaluate(`
  const [entry] = performance.getEntriesByType('navigation')
  return entry ? {
    responseEnd: Math.round(entry.responseEnd),
    domContentLoaded: Math.round(entry.domContentLoadedEventEnd),
    loadEvent: Math.round(entry.loadEventEnd),
    domInteractive: Math.round(entry.domInteractive)
  } : null
`)

const scripts = await evaluate(`
  return performance.getEntriesByType('resource')
    .filter((entry) => entry.name.endsWith('.js') || entry.name.endsWith('.css'))
    .map((entry) => ({ name: entry.name.split('/').pop(), ms: Math.round(entry.duration), size: Math.round((entry.encodedBodySize ?? 0) / 1024) }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 6)
`)

// Each startup IPC call, measured on its own. These all run inside init().
const ipc = await evaluate(`
  const calls = {
    listRepos: () => window.api.listRepos(),
    getSettings: () => window.api.getSettings(),
    listSessions: () => window.api.listSessions(),
    detectHarnesses: () => window.api.detectHarnesses(),
    listRavel: () => window.api.listRavel(),
    listRoundtables: () => window.api.listRoundtables(),
    getSettingsLoadError: () => window.api.getSettingsLoadError(),
    resolveModelCatalogues: () => window.api.resolveModelCatalogues()
  }
  const out = []
  for (const [name, run] of Object.entries(calls)) {
    const started = performance.now()
    try { await run() } catch (e) { /* cost is the measurement */ }
    out.push({ name, ms: Math.round(performance.now() - started) })
  }
  return out.sort((a, b) => b.ms - a.ms)
`)

process.stdout.write(`\n=== startup phases (${cold ? 'cold' : 'warm'} user-data) ===\n`)
let previous = 0
for (const entry of marks) {
  process.stdout.write(`${String(entry.ms).padStart(6)}ms  (+${String(entry.ms - previous).padStart(5)}ms)  ${entry.label}\n`)
  previous = entry.ms
}
process.stdout.write(`\n=== renderer navigation timing ===\n${JSON.stringify(nav, null, 1)}\n`)
process.stdout.write(`\n=== slowest assets ===\n`)
for (const s of scripts) process.stdout.write(`${String(s.ms).padStart(6)}ms  ${String(s.size).padStart(5)}KB  ${s.name}\n`)
process.stdout.write(`\n=== startup IPC calls, measured individually ===\n`)
for (const call of ipc) process.stdout.write(`${String(call.ms).padStart(6)}ms  ${call.name}\n`)

socket.close()
try {
  process.kill(child.pid)
} catch {
  /* already gone */
}
if (existsSync(USER_DATA)) process.exit(0)
