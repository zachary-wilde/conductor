/**
 * Headless remote-access helper for on-device verification.
 *
 * Boots the standalone Conductor Core bound to the LAN (`0.0.0.0`) with an
 * auto-generated bearer token, then prints the pairing URL + token + `C1:` code
 * and a terminal QR so a phone running the APK can pair without opening the
 * desktop UI. Keeps the Core running until Ctrl+C.
 *
 * The Core owns a single-instance lock per data dir, so if the desktop app is
 * already running on this `--base` the boot is refused — close the app, pass a
 * different `--base`, or launch the app with CONDUCTOR_WEB_HOST=0.0.0.0 instead.
 *
 * Usage: node scripts/remote-access.mjs [--port 8787] [--base <userData dir>]
 * Requires a prior `npm run build` (needs out/main/core.js + out/web).
 */
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const args = process.argv.slice(2)
const argVal = (flag, fallback) => {
  const i = args.indexOf(flag)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const webPort = argVal('--port', '8787')
const base = argVal('--base', join(process.env.APPDATA || join(homedir(), '.config'), 'conductor'))

const coreEntry = join(ROOT, 'out', 'main', 'core.js')
const webStatic = join(ROOT, 'out', 'web')
if (!existsSync(coreEntry)) {
  process.stderr.write(`missing ${coreEntry} — run \`npm run build\` first\n`)
  process.exit(2)
}

function electronBinary() {
  const path = require('electron')
  if (typeof path !== 'string' || !existsSync(path)) {
    process.stderr.write('cannot locate the electron binary — run `npm install`\n')
    process.exit(2)
  }
  return path
}

const endpointFile = join(base, 'conductor-data', 'v2', 'core-endpoint.json')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const child = spawn(electronBinary(), [coreEntry], {
  cwd: ROOT,
  stdio: ['ignore', 'inherit', 'inherit'],
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    CONDUCTOR_CORE_ENTRY: '1',
    CONDUCTOR_CORE_BASE: base,
    CONDUCTOR_WEB_HOST: '0.0.0.0',
    CONDUCTOR_WEB_PORT: String(webPort),
    CONDUCTOR_WEB_STATIC: webStatic
  }
})
child.on('exit', (code) => {
  if (code && code !== 0) process.stderr.write(`\nCore exited with code ${code} (lock held? try --base or close the desktop app)\n`)
  process.exit(code ?? 0)
})

/** One control call over the Core's loopback channel (line-delimited JSON). */
function controlCall(port, method, ...params) {
  return new Promise((res, rej) => {
    const socket = connect(port, '127.0.0.1')
    socket.setEncoding('utf8')
    let buf = ''
    socket.on('connect', () => socket.write(JSON.stringify({ id: 1, method, args: params }) + '\n'))
    socket.on('data', (d) => {
      buf += d
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      const frame = JSON.parse(buf.slice(0, nl))
      socket.destroy()
      frame.ok ? res(frame.value) : rej(new Error(frame.error ?? 'call failed'))
    })
    socket.on('error', rej)
  })
}

async function readEndpoint() {
  for (let i = 0; i < 100; i++) {
    if (existsSync(endpointFile)) {
      try {
        return JSON.parse(readFileSync(endpointFile, 'utf8'))
      } catch {
        /* torn write; retry */
      }
    }
    await sleep(200)
  }
  throw new Error('the Core never published its endpoint')
}

const ep = await readEndpoint()
const pairing = await controlCall(ep.controlPort, 'operations:pairing')
if (!pairing?.url || !pairing?.code) {
  process.stderr.write('the Core did not report pairing info (is the web server bound?)\n')
  process.exit(1)
}

const QRCode = require('qrcode')
const qr = await QRCode.toString(pairing.code, { type: 'terminal', small: true })

process.stdout.write('\n=== Conductor remote access (LAN) ===\n')
process.stdout.write(`URL:   ${pairing.url}\n`)
process.stdout.write(`Token: ${pairing.token ?? '(none)'}\n`)
process.stdout.write(`Code:  ${pairing.code}\n\n`)
process.stdout.write('Scan this in the Conductor app (or paste the code above):\n')
process.stdout.write(qr + '\n')
process.stdout.write('Core is running. Press Ctrl+C to stop.\n')

const stop = () => {
  try {
    child.kill()
  } catch {
    /* already gone */
  }
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
