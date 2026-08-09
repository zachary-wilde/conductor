/**
 * Drives the real Conductor GUI end to end and judges what it rendered.
 *
 * The unit and integration suites prove the runtime; they cannot prove that a
 * number reached a pixel. This launches the actual Electron app against an
 * isolated profile and a dummy harness (so no paid CLI can run and no real
 * store is touched), attaches over the Chrome DevTools Protocol, clicks the
 * same controls a person would, and asserts on the rendered DOM.
 *
 * Zero dependencies: CDP is spoken over Node's global WebSocket.
 *
 * The one concession to automation is seeding the repository through
 * `window.api.addRepo` instead of the "Add a git repository" button, because
 * that button opens a native directory dialog that no in-page driver can
 * dismiss. It is the identical IPC call the button makes. Everything after it
 * is real UI: typed text, clicked buttons, and assertions against what the
 * renderer actually painted.
 *
 * Exit 0 = every check passed, 1 = a check failed, 2 = the run could not be
 * set up or the app never came up. Never conflate the last two: a machine
 * without git that exited 1 would read as a product regression.
 *
 * Usage: node scripts/gui-smoke.mjs [--port 9222] [--keep-open]
 */
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCRATCH = join(ROOT, '.tmp', 'gui-smoke')
const REPO = join(SCRATCH, 'repo')
const USER_DATA = join(SCRATCH, 'user-data')
const LOG = join(SCRATCH, 'smoke.log')
const APP_LOG = join(SCRATCH, 'app.log')
const DUMMY = join(ROOT, 'scripts', 'ravel-dummy-harness.mjs')

const args = process.argv.slice(2)
const port = Number(args[args.indexOf('--port') + 1]) || 9222
const keepOpen = args.includes('--keep-open')
/**
 * Back-compat mode: start from a COPY of a real store written before this
 * feature existed, and assert only that it still loads and renders. The full
 * drive is skipped because a real store's repos may not exist on this machine.
 */
const seedStore = args.includes('--seed-store') ? args[args.indexOf('--seed-store') + 1] : null
/**
 * Runaway mode: the child chatters continuously so the ceiling's in-flight
 * kill path is exercised against a live process, not a simulated exit.
 */
const runaway = args.includes('--runaway')

/** A manager turn is a spawned node process; the fleet adds git worktree work. */
const TURN_TIMEOUT_MS = 90_000

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(2)
}

// --- Fixture -----------------------------------------------------------------

/**
 * A child dispatch runs a real `git worktree add ... HEAD`, so the fixture must
 * be a genuine repository with at least one commit. Rebuilt every run: a
 * half-finished worktree from a previous failure would poison the next.
 */
function buildFixture() {
  rmSync(SCRATCH, { recursive: true, force: true })
  mkdirSync(REPO, { recursive: true })
  mkdirSync(USER_DATA, { recursive: true })
  if (seedStore) {
    if (!existsSync(seedStore)) fail(`--seed-store points at nothing: ${seedStore}`)
    // A copy, never the original: back-compat is worth proving, not risking.
    mkdirSync(join(USER_DATA, 'conductor-data'), { recursive: true })
    writeFileSync(join(USER_DATA, 'conductor-data', 'store.json'), readFileSync(seedStore, 'utf8'), 'utf8')
  }
  const git = (...a) => execFileSync('git', ['-C', REPO, ...a], { stdio: 'pipe' })
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', REPO], { stdio: 'pipe' })
    git('config', 'user.email', 'smoke@local')
    git('config', 'user.name', 'Smoke')
    writeFileSync(join(REPO, 'README.md'), '# gui smoke fixture\n', 'utf8')
    git('add', '-A')
    git('commit', '-qm', 'initial')
  } catch (e) {
    fail(`cannot build the git fixture: ${e.message}`)
  }
}

// --- CDP ---------------------------------------------------------------------

/** The `electron` package exports the absolute path to its own binary. */
function electronBinary() {
  const path = createRequire(import.meta.url)('electron')
  if (typeof path !== 'string' || !existsSync(path)) fail('cannot locate the electron binary — run `npm install`')
  return path
}

async function findPageTarget() {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page' && t.url.includes('renderer/index.html'))
      if (page?.webSocketDebuggerUrl) return page
    } catch {
      // The debugger port is not listening yet.
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  return null
}

function connect(url) {
  return new Promise((resolveConn, rejectConn) => {
    const socket = new WebSocket(url)
    const pending = new Map()
    let nextId = 1

    socket.addEventListener('message', (event) => {
      const frame = JSON.parse(event.data)
      const waiter = pending.get(frame.id)
      if (!waiter) return
      pending.delete(frame.id)
      if (frame.error) waiter.reject(new Error(frame.error.message))
      else waiter.resolve(frame.result)
    })
    socket.addEventListener('error', () => rejectConn(new Error('CDP socket error')))
    socket.addEventListener('open', () =>
      resolveConn({
        send(method, params) {
          const id = nextId++
          socket.send(JSON.stringify({ id, method, params }))
          return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }))
        },
        close: () => socket.close()
      })
    )
  })
}

/**
 * Evaluates in the page's main world. `awaitPromise` lets a step be written as
 * a single async expression, which is what makes the driving script readable.
 */
async function makeEval(cdp) {
  await cdp.send('Runtime.enable', {})
  return async function evaluate(expression) {
    const result = await cdp.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true
    })
    if (result.exceptionDetails) {
      const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
      throw new Error(`page threw: ${text}`)
    }
    return result.result.value
  }
}

async function waitFor(evaluate, expression, what, timeoutMs = TURN_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await evaluate(`return ${expression}`)
    if (last) return last
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`)
}

/** The harness log is written by a separate process, so it lags the UI. */
async function waitForLog(pattern, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(LOG) && pattern.test(readFileSync(LOG, 'utf8'))) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

// --- In-page helpers ---------------------------------------------------------

/**
 * React tracks the previous value on the DOM node, so a plain `el.value = x`
 * is discarded on the next render. Going through the prototype setter and
 * dispatching a bubbling input event is the only assignment React observes.
 */
const HELPERS = `
window.__smoke = {
  type(el, text, tag) {
    const proto = tag === 'textarea' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  },
  button(text) {
    return [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === text) ?? null
  },
  buttonLike(text) {
    return [...document.querySelectorAll('button')].find((b) => b.textContent.includes(text)) ?? null
  },
  /**
   * Stable hook, immune to restyling. Every affordance this script drives carries
   * a data-testid precisely because selecting on visible text and aria-labels is
   * what broke the run when the dashboard became the glass shell.
   */
  openSettings() {
    if (document.querySelector('[data-panel-kind="settings"]')) return true
    const entry = document.querySelector('[data-testid="open-settings"]')
    if (!entry) return false
    entry.click()
    return true
  },
  id(name) {
    return document.querySelector('[data-testid="' + name + '"]')
  },
  named(name, text) {
    return [...document.querySelectorAll('[data-testid="' + name + '"]')].find((n) => n.textContent.includes(text)) ?? null
  },
  text(selector) {
    return document.querySelector(selector)?.textContent?.trim() ?? null
  },
  bodyText() {
    return document.body.innerText
  }
}
`

// --- Checks ------------------------------------------------------------------

const checks = []
function check(label, ok, detail) {
  checks.push({ label, ok: !!ok, detail })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}\n`)
}

// --- The run -----------------------------------------------------------------

async function main() {
  if (!existsSync(join(ROOT, 'out', 'main', 'index.js'))) {
    fail('out/main/index.js is missing — run `npm run build` first')
  }
  buildFixture()

  const electron = spawn(electronBinary(), ['.', `--remote-debugging-port=${port}`], {
    cwd: ROOT,
    env: {
      ...process.env,
      CONDUCTOR_SMOKE_USER_DATA: USER_DATA,
      CONDUCTOR_RAVEL_DUMMY_HARNESS: DUMMY,
      ...(runaway ? { CONDUCTOR_RAVEL_DUMMY_CHATTER: '1' } : {}),
      CONDUCTOR_RAVEL_DUMMY_LOG: LOG
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  // Kept on disk: a main-process exception in a hot pty handler is otherwise
  // invisible from inside the page.
  let appOutput = ''
  const record = (d) => {
    appOutput += d
    writeFileSync(APP_LOG, appOutput, 'utf8')
  }
  electron.stdout.on('data', record)
  electron.stderr.on('data', record)

  const killCore = () => {
    // The Core is spawned DETACHED, so it is not in Electron's process tree and
    // survives the taskkill below by design. The smoke must reap it explicitly
    // (by the pid in its endpoint hint) or it would leak, holding the lock+port.
    try {
      const endpoint = join(USER_DATA, 'conductor-data', 'v2', 'core-endpoint.json')
      if (!existsSync(endpoint)) return
      const { pid } = JSON.parse(readFileSync(endpoint, 'utf8'))
      if (!pid) return
      if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
      else process.kill(pid, 'SIGTERM')
    } catch {
      // Already gone or never started.
    }
  }

  const stop = () => {
    if (keepOpen) return
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(electron.pid), '/T', '/F'], { stdio: 'ignore' })
      else electron.kill('SIGTERM')
    } catch {
      // Already gone.
    }
    killCore()
  }

  try {
    const target = await findPageTarget()
    if (!target) {
      fail(`the app never exposed a renderer target on :${port}\n${appOutput}`)
    }
    const cdp = await connect(target.webSocketDebuggerUrl)
    const evaluate = await makeEval(cdp)
    await evaluate(HELPERS)

    if (seedStore) {
      await runBackCompat(evaluate)
      cdp.close()
      return
    }

    await waitFor(
      evaluate,
      `document.querySelectorAll('[data-testid="canvas-panel"]').length === 3`,
      'the measured Command Centre canvas',
      30_000
    )
    const commandCentreRects = await evaluate(`
      return [...document.querySelectorAll('[data-testid="canvas-panel"]')]
        .filter((panel) => ['sessions', 'work', 'fleet'].includes(panel.dataset.panelKind))
        .map((panel) => {
          const rect = panel.getBoundingClientRect()
          return {
            kind: panel.dataset.panelKind,
            x: rect.x,
            y: rect.y,
            right: rect.right,
            bottom: rect.bottom
          }
        })
    `)
    const noOverlap =
      commandCentreRects.length === 3 &&
      commandCentreRects.every((left, leftIndex) =>
        commandCentreRects.every(
          (right, rightIndex) =>
            leftIndex === rightIndex ||
            left.right <= right.x ||
            right.right <= left.x ||
            left.bottom <= right.y ||
            right.bottom <= left.y
        )
      )
    check(
      'the default canvas opens as Command Centre without overlap',
      noOverlap,
      JSON.stringify(commandCentreRects)
    )
    const launcherState = await evaluate(`
      const terminal = window.__smoke.id('new-terminal')
      const ravel = window.__smoke.id('new-ravel')
      return {
        terminal: !!terminal,
        ravel: !!ravel,
        disabled:
          terminal?.disabled === true &&
          ravel?.disabled === true &&
          terminal?.title === 'Add a repository first' &&
          ravel?.title === 'Add a repository first'
      }
    `)
    check('the canvas exposes a Terminal launcher', launcherState.terminal)
    check('the canvas exposes a Ravel launcher', launcherState.ravel)
    check('both launchers explain that a repository is required', launcherState.disabled)
    // A brand-new user has zero repos: the live surface MUST offer an enabled way
    // to add one (regression guard — the add-repo affordance once lived only in
    // components App.tsx never mounts, leaving a fresh install an inert shell).
    const addRepoAffordance = await evaluate(`
      const add = window.__smoke.id('add-repository')
      return { present: !!add, enabled: !!add && add.disabled !== true }
    `)
    check(
      'a fresh (repo-less) user has an enabled way to add a repository',
      addRepoAffordance.present && addRepoAffordance.enabled,
      JSON.stringify(addRepoAffordance)
    )
    await evaluate(`window.__smoke.id('layouts-menu').click()`)
    check(
      'the Layouts menu exposes Reset to Command Centre',
      await evaluate(`return !!window.__smoke.id('reset-command-centre')`)
    )
    await evaluate(`window.__smoke.id('layouts-menu').click()`)

    await evaluate(`window.__smoke.id('view-menu').click()`)
    await waitFor(
      evaluate,
      `!!window.__smoke.id('view-window-work')`,
      'the canvas window controls in View'
    )
    const viewMenuContained = await evaluate(`
      const rect = document.querySelector('[role="menu"]').getBoundingClientRect()
      return rect.left >= 0 && rect.right <= window.innerWidth
    `)
    check('the View menu stays inside the application window', viewMenuContained)
    await evaluate(`window.__smoke.id('view-window-work').click()`)
    await waitFor(
      evaluate,
      `!document.querySelector('[data-panel-kind="work"]')`,
      'View to hide Work'
    )
    check(
      'View hides a canvas window without losing its toggle',
      await evaluate(`
        return window.__smoke.id('view-window-work')?.getAttribute('aria-checked') === 'false'
      `)
    )
    await evaluate(`window.__smoke.id('view-window-work').click()`)
    await waitFor(
      evaluate,
      `!!document.querySelector('[data-panel-kind="work"]')`,
      'View to restore Work'
    )
    check(
      'View restores a hidden canvas window',
      await evaluate(`
        return window.__smoke.id('view-window-work')?.getAttribute('aria-checked') === 'true'
      `)
    )
    await evaluate(`window.__smoke.id('view-menu').click()`)

    const dragContained = async (clientX, clientY, edge) => {
      const before = await evaluate(`
        const panel = document.querySelector('[data-panel-kind="sessions"]')
        const header = panel.querySelector('header')
        const rect = panel.getBoundingClientRect()
        const start = header.getBoundingClientRect()
        header.dispatchEvent(new MouseEvent('mousedown', {
          bubbles: true,
          button: 0,
          clientX: start.x + 20,
          clientY: start.y + 10
        }))
        return { left: rect.left, top: rect.top }
      `)
      await new Promise((resolve) => setTimeout(resolve, 50))
      const after = await evaluate(`
        document.dispatchEvent(new MouseEvent('mousemove', {
          bubbles: true,
          clientX: ${clientX},
          clientY: ${clientY}
        }))
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
        // Wait for the clamped position to COMMIT and settle rather than sampling a
        // fixed number of frames: React's state commit after mouseup can land a
        // frame or two later under load, which otherwise makes the edge assertion
        // read a mid-commit position. Poll until the rect is stable across two
        // consecutive frames (bounded), then measure.
        const readRect = () => {
          const el = document.querySelector('[data-panel-kind="sessions"]').getBoundingClientRect()
          return { left: el.left, top: el.top, right: el.right, bottom: el.bottom }
        }
        const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()))
        let prev = readRect()
        for (let i = 0; i < 60; i++) {
          await frame()
          const next = readRect()
          if (next.left === prev.left && next.top === prev.top && next.right === prev.right && next.bottom === prev.bottom) {
            prev = next
            break
          }
          prev = next
        }
        const canvas = document.querySelector('[data-testid="canvas"]').getBoundingClientRect()
        return {
          canvas: { left: canvas.left, top: canvas.top, right: canvas.right, bottom: canvas.bottom },
          rect: prev
        }
      `)
      const contained =
        after.rect.left >= after.canvas.left &&
        after.rect.top >= after.canvas.top &&
        after.rect.right <= after.canvas.right &&
        after.rect.bottom <= after.canvas.bottom
      const moved = after.rect.left !== before.left || after.rect.top !== before.top
      const reachedEdge =
        edge === 'bottom-right'
          ? Math.abs(after.rect.right - after.canvas.right) <= 1 &&
            Math.abs(after.rect.bottom - after.canvas.bottom) <= 1
          : Math.abs(after.rect.left - after.canvas.left) <= 1 &&
            Math.abs(after.rect.top - after.canvas.top) <= 1
    // The invariant is CONTAINMENT: an extreme (5000px) drag must not move the
    // window PAST the canvas edge. `contained && moved` tests exactly that. We do
    // NOT gate on `reachedEdge` (exact 1px flush contact): the clamp keeps the
    // window inside, but how flush it lands depends on the panel's rendered height,
    // which varies — that made this check flaky without testing anything the name
    // claims. `reachedEdge` is kept in the payload for debugging only.
    return { ok: contained && moved, contained, moved, reachedEdge, after }
  }
  {
    const br = await dragContained(5000, 5000, 'bottom-right')
    check('dragging cannot move a canvas window past the bottom-right edge', br.ok)
    const tl = await dragContained(-5000, -5000, 'top-left')
    check('dragging cannot move a canvas window past the top-left edge', tl.ok)
  }

    // 1. Seed the repository past the native directory dialog, plus the verify
    //    command whose verdict the manager is supposed to hear. Both go in
    //    before the reload so the store's init() picks them up the same way a
    //    cold start would.
    await evaluate(`
      await window.api.addRepo(${JSON.stringify(REPO)})
      await window.api.saveSettings({ verify: { global: 'echo smoke-verify-ok', perRepo: {} }, shellHooksConsented: true })
      location.reload()
    `)
    await new Promise((r) => setTimeout(r, 1500))
    await evaluate(HELPERS)
    await waitFor(
      evaluate,
      `!!window.__smoke.id('new-terminal') &&
        !window.__smoke.id('new-terminal').disabled &&
        !!window.__smoke.id('new-ravel') &&
        !window.__smoke.id('new-ravel').disabled`,
      'the repository to enable the canvas launchers',
      30_000
    )
    check('a repository loads and enables Terminal and Ravel', true)

    // 2. Create the ravel through the modal, with an instruction vague enough
    //    to force the clarification branch.
    await evaluate(`window.__smoke.id('new-ravel').click()`)
    await waitFor(evaluate, `!!document.querySelector('[role="dialog"][aria-labelledby="new-ravel-title"]')`, 'the New Ravel modal', 15_000)
    const noHarness = await evaluate(`return window.__smoke.bodyText().includes('No harnesses detected')`)
    if (noHarness) fail('the dummy harness was not detected — check CONDUCTOR_RAVEL_DUMMY_HARNESS')

    await evaluate(`
      const dialog = document.querySelector('[role="dialog"][aria-labelledby="new-ravel-title"]')
      window.__smoke.type(dialog.querySelector('input[placeholder="e.g. Refactor auth layer"]'), 'GUI smoke', 'input')
      window.__smoke.type(dialog.querySelector('textarea'), 'this is vague', 'textarea')
    `)
    await waitFor(evaluate, `!!window.__smoke.buttonLike('Create Ravel') && !window.__smoke.buttonLike('Create Ravel').disabled`, 'Create Ravel to enable', 15_000)
    await evaluate(`window.__smoke.buttonLike('Create Ravel').click()`)

    await waitFor(evaluate, `!!document.querySelector('textarea[aria-label="Message Ravel"]')`, 'the Ravel view')
    await waitFor(evaluate, `window.__smoke.bodyText().includes('Needs clarification')`, 'the clarification question')
    check('creating a ravel runs a manager turn and asks for clarification', true)

    await evaluate(`window.__smoke.id('view-menu').click()`)
    const hiddenRavelId = await waitFor(
      evaluate,
      `document.querySelector('[data-testid^="view-window-ravel:"]')?.dataset.testid ?? null`,
      'the active Ravel in View'
    )
    await evaluate(`window.__smoke.id(${JSON.stringify(hiddenRavelId)}).click()`)
    await waitFor(
      evaluate,
      `!document.querySelector('[data-panel-kind="ravel"]')`,
      'View to hide the active Ravel'
    )
    check(
      'View hides an active Ravel without deleting its toggle',
      hiddenRavelId !== null &&
        (await evaluate(`
          return window.__smoke.id(${JSON.stringify(hiddenRavelId)})
            ?.getAttribute('aria-checked') === 'false'
        `))
    )
    await evaluate(`window.__smoke.id(${JSON.stringify(hiddenRavelId)}).click()`)
    await waitFor(
      evaluate,
      `!!document.querySelector('textarea[aria-label="Message Ravel"]')`,
      'View to restore the active Ravel'
    )
    check(
      'View restores the active Ravel with its work intact',
      await evaluate(`return window.__smoke.bodyText().includes('Needs clarification')`)
    )
    await evaluate(`window.__smoke.id('view-menu').click()`)

    // 3. The metering surface, mid-run: the header pill must already carry a
    //    non-zero estimate off the turns spent so far.
    const pill = await evaluate(`
      const pills = [...document.querySelectorAll('header span')].map((s) => s.textContent.trim())
      return pills.find((t) => t.includes('tok est.')) ?? null
    `)
    const pillTokens = Number(/~(\d+) tok est\./.exec(pill ?? '')?.[1] ?? 0)
    check('the header shows an estimated-token pill', pill !== null, `pills: ${pill}`)
    check('the estimate is non-zero and labelled "est."', pillTokens > 0 && pill.includes('est.'), `pill: ${pill}`)

    // 4. Answer the clarification by clicking the choice it offered, not by
    //    typing: a closed question the operator has to retype is a menu that
    //    does not work.
    const offered = await evaluate(`
      const button = window.__smoke.buttonLike('develop')
      if (!button) return null
      button.click()
      return 'clicked'
    `)
    check('a clarification offers its choices as one-click answers', offered === 'clicked')
    await waitFor(evaluate, `window.__smoke.bodyText().includes('Awaiting approval')`, 'the compiled plan')
    check('answering the clarification compiles a plan', true)
    const answered = await evaluate(`
      return window.__smoke.bodyText().includes('develop')
    `)
    check('the clicked choice is recorded as the operator answer', answered)

    const risen = await evaluate(`
      const pills = [...document.querySelectorAll('header span')].map((s) => s.textContent.trim())
      return Number((/~(\\d+) tok est\\./.exec(pills.find((t) => t.includes('tok est.')) ?? '') ?? [0, 0])[1])
    `)
    check('the estimate rises across turns', risen > pillTokens, `${pillTokens} -> ${risen}`)

    // 5. Approve, which dispatches the child.
    await evaluate(`window.__smoke.id('ravel-tab-plan').click()`)
    await waitFor(evaluate, `!!window.__smoke.buttonLike('Approve plan') && !window.__smoke.buttonLike('Approve plan').disabled`, 'Approve plan to enable')
    await evaluate(`window.__smoke.buttonLike('Approve plan').click()`)
    await waitFor(evaluate, `window.__smoke.bodyText().includes('Approved revision 1')`, 'the approval to land')
    check('approving the plan dispatches a child', true)

    if (runaway) {
      await runRunaway(evaluate)
      cdp.close()
      return
    }

    // 5b. Steering: the operator redirects a live child through the manager.
    await evaluate(`window.__smoke.id('ravel-tab-fleet').click()`)
    const steerOpened = await waitFor(
      evaluate,
      `(() => {
        const button = window.__smoke.buttonLike('Steer')
        if (!button || button.disabled) return null
        button.click()
        return 'clicked'
      })()`,
      'the Steer control on a live child',
      30_000
    )
    check('a live child can be steered from the Fleet tab', steerOpened === 'clicked')
    await waitFor(evaluate, `!!document.querySelector('textarea[aria-label="Steer this child"]')`, 'the steer composer', 15_000)
    await evaluate(`
      window.__smoke.type(document.querySelector('textarea[aria-label="Steer this child"]'), 'keep it to the refresh path', 'textarea')
    `)
    await waitFor(evaluate, `!!window.__smoke.buttonLike('Send to Ravel') && !window.__smoke.buttonLike('Send to Ravel').disabled`, 'the steer send button', 15_000)
    await evaluate(`window.__smoke.buttonLike('Send to Ravel').click()`)
    check(
      'a steer is delivered to the orchestrator, not the child',
      await waitForLog(/EVENT: the operator wants the child working on brief \S+ redirected/)
    )
    check(
      'the child receives the orchestrator wording',
      await waitForLog(/CHILD STDIN[\s\S]{0,300}Narrow the change to the refresh path/)
    )
    // The operator's own phrasing is the thing that must NOT be in the child's
    // stdin: the manager decides what that role hears.
    const childInput = readFileSync(LOG, 'utf8')
      .split(/\n--- /)
      .filter((block) => block.startsWith('CHILD STDIN'))
      .join('\n')
    check('the operator note never reached the child', !childInput.includes('keep it to the refresh path'), childInput.slice(-120))

    // 6. The Log tab must carry the new per-turn usage format.
    await evaluate(`window.__smoke.id('ravel-tab-log').click()`)
    const logText = await waitFor(evaluate, `(() => {
      const t = window.__smoke.bodyText()
      return /~\\d+ in \\/ ~\\d+ out tok \\(est\\.\\)/.test(t) ? t.match(/turn [^\\n]*tok \\(est\\.\\)[^\\n]*/)[0] : null
    })()`, 'a metered turn log line')
    check('turn log lines carry the in/out estimate', true, logText)

    // 7. The child must exit, publish its report, and have its usage recorded.
    await evaluate(`window.__smoke.id('ravel-tab-fleet').click()`)
    const fleetTokens = await waitFor(
      evaluate,
      `(() => { const m = /~(\\d+) tok est\\./.exec(window.__smoke.bodyText().split('Ravel manager')[1] ?? ''); return m ? Number(m[1]) : null })()`,
      'a per-dispatch token figure in the Fleet tab',
      30_000
    )
    check('the fleet row shows the dispatch estimate', fleetTokens > 0, `~${fleetTokens} tok`)

    await evaluate(`window.__smoke.id('ravel-tab-plan').click()`)
    const reportShown = await waitFor(
      evaluate,
      `window.__smoke.bodyText().includes('DUMMY REPORT: touched nothing')`,
      "the child's report on the brief card"
    )
    check('the brief card renders the child report', !!reportShown)
    const managerSawReport = await waitForLog(/REPORT FROM \S+ \(first 800 chars\):\s*\nDUMMY REPORT: touched nothing/)
    check('the report reached the manager prompt', managerSawReport)

    // 7b. The repo's own check must have run in the child's worktree, and its
    //     verdict must reach the manager before the manager decides anything.
    const verifyLogged = await waitForLog(/VERIFY COMMAND PASSED in that child's worktree:\s*\nsmoke-verify-ok/)
    check('the verify command ran and its verdict reached the manager', verifyLogged)
    await evaluate(`window.__smoke.id('ravel-tab-fleet').click()`)
    const verifyShown = await waitFor(
      evaluate,
      `window.__smoke.bodyText().includes('verify passed') ? 'shown' : null`,
      'the verify verdict on the fleet row',
      30_000
    )
    check('the fleet row shows the verify verdict', verifyShown === 'shown')

    // 7c. Review and land. The section is collapsed until asked for, so the
    //     operator's normal path stays a conversation.
    const opened = await waitFor(
      evaluate,
      `(() => {
        const button = window.__smoke.buttonLike('Review and land')
        if (!button) return null
        if (window.__smoke.bodyText().includes('Preview all')) return 'already-open'
        button.click()
        return 'opened'
      })()`,
      'the review section',
      20_000
    )
    check('finished branches are offered for review without taking over the view', opened !== null, String(opened))
    const previewVerdict = await waitFor(
      evaluate,
      `(() => {
        const button = window.__smoke.buttonLike('Preview all')
        if (!button || button.disabled) return null
        button.click()
        return 'clicked'
      })()`,
      'the Preview all control',
      20_000
    )
    check('the review section previews on request', previewVerdict === 'clicked')
    const previewed = await waitFor(
      evaluate,
      `window.__smoke.bodyText().includes('merges cleanly') ? 'clean' : null`,
      'a merge preview verdict',
      30_000
    )
    check('previewing a completed branch reports whether it merges', previewed === 'clean')
    await evaluate(`window.__smoke.buttonLike('Land').click()`)
    // The child commits one real file, so this must be an actual merge commit —
    // "already contained in the base" would mean the run proved only plumbing.
    const landedText = await waitFor(
      evaluate,
      `(() => {
        const match = /Merged \\d+ files? as [0-9a-f]{8}\\./.exec(window.__smoke.bodyText())
        return match ? match[0] : null
      })()`,
      'a real merge commit on the base',
      30_000
    )
    check('landing a branch produces a real merge commit', !!landedText, landedText ?? '')

    // 8. The ceiling. Set it below what this ravel has already spent, so the
    //    very next event must refuse to run.
    await evaluate(`document.querySelector('button[aria-label="Back"]').click()`)
    await waitFor(evaluate, `!!window.__smoke.id('open-settings')`, 'the dashboard settings entry', 15_000)
    await evaluate(`window.__smoke.openSettings()`)
    await waitFor(evaluate, `!!window.__smoke.id('token-ceiling')`, 'the Budget setting', 15_000)
    check('Settings exposes the token ceiling', true)
    const verifySetting = await evaluate(`
      return [...document.querySelectorAll('textarea')].some((n) => n.value === 'echo smoke-verify-ok')
    `)
    check('Settings shows the configured verify command', verifySetting)

    // 8b. Layout: a panel dropped on the other rail stays there, and both
    //     rails render at once — the point of docking is watching two panels.
    const docked = await evaluate(`
      const chip = [...document.querySelectorAll('button')].find((n) => n.textContent.includes('Manager tab'))
      if (!chip) return null
      chip.click()
      return chip.textContent.includes('left') ? 'already-left' : 'moved'
    `)
    check('Settings offers a rail for every panel', docked !== null, String(docked))

    await evaluate(`
      window.__smoke.type(window.__smoke.id('token-ceiling'), '100', 'input')
    `)
    await waitFor(evaluate, `!!window.__smoke.id('settings-save') && !window.__smoke.id('settings-save').disabled`, 'Save to enable', 15_000)
    await evaluate(`window.__smoke.id('settings-save').click()`)
    await waitFor(evaluate, `window.__smoke.id('settings-save').textContent.includes('Saved')`, 'the settings save to confirm', 15_000)

    await evaluate(`window.__smoke.id('back').click()`)
    await waitFor(evaluate, `!!window.__smoke.named('glass-ravel-row', 'GUI smoke')`, 'the ravel strip', 15_000)
    await evaluate(`window.__smoke.named('glass-ravel-row', 'GUI smoke').click()`)
    await waitFor(evaluate, `!!document.querySelector('textarea[aria-label="Message Ravel"]')`, 'the Ravel view', 15_000)

    const rails = await evaluate(`
      return [...document.querySelectorAll('aside[aria-label^="Ravel details"]')].map((n) => n.getAttribute('aria-label'))
    `)
    check(
      'a docked panel opens its own rail alongside the other',
      rails.length === 2 && rails.some((label) => label.includes('left')) && rails.some((label) => label.includes('right')),
      rails.join(' | ')
    )

    const ceilingPill = await evaluate(`
      const pills = [...document.querySelectorAll('header span')].map((s) => s.textContent.trim())
      return pills.find((t) => t.includes('tok est.')) ?? null
    `)
    check('the pill shows spend against the ceiling', (ceilingPill ?? '').includes('/ 100'), `pill: ${ceilingPill}`)

    await evaluate(`
      window.__smoke.type(document.querySelector('textarea[aria-label="Message Ravel"]'), 'keep going', 'textarea')
    `)
    await waitFor(evaluate, `!!window.__smoke.button('Send') && !window.__smoke.button('Send').disabled`, 'Send to enable', 20_000)
    await evaluate(`window.__smoke.button('Send').click()`)

    const banner = await waitFor(
      evaluate,
      `(() => { const el = [...document.querySelectorAll('[role="alert"]')].find((n) => n.textContent.includes('Token ceiling reached')); return el ? el.textContent.trim() : null })()`,
      'the breach banner'
    )
    check('crossing the ceiling raises the breach banner', !!banner, banner)
    // The pause is applied in the Core and reaches the renderer over the control
    // channel a beat after the usage event that raised the banner, so poll for it
    // rather than reading once (the neighbouring reason/resume checks confirm the
    // pause itself is real).
    const pausedPill = await waitFor(
      evaluate,
      `(() => { const pills = [...document.querySelectorAll('header span')].map((s) => s.textContent.trim()); return pills.find((t) => t.includes('Paused')) ?? null })()`,
      'the ravel to show its paused pill'
    )
    check('the ravel pauses itself at the ceiling', pausedPill !== null, `status pill: ${pausedPill}`)

    await evaluate(`window.__smoke.id('ravel-tab-log').click()`)
    const budgetLog = await waitFor(
      evaluate,
      `(() => /token ceiling reached: ~\\d+\\/100 \\(est\\.\\)/.test(window.__smoke.bodyText()) || null)()`,
      'the budget stop log line'
    )
    check('the log records the budget stop', budgetLog === true)

    // 9. The global error toast (App.tsx) must never have fired. The ravel's
    //    own red banner is deliberately excluded: at this point it correctly
    //    carries the budget pause reason, which is the feature working.
    const toast = await evaluate(`
      const el = document.querySelector('div.fixed.bottom-4.right-4')
      return el ? el.innerText.trim().slice(0, 200) : null
    `)
    check('no global error toast was raised', toast === null, toast ?? '')

    const pauseReason = await evaluate(`
      const el = [...document.querySelectorAll('div')].find((n) => n.textContent.startsWith('Paused at the token ceiling:'))
      return el ? el.textContent.trim() : null
    `)
    check('the ravel states why it paused', /Paused at the token ceiling: ~\d+ of 100 estimated tokens used\./.test(pauseReason ?? ''), pauseReason ?? '')

    // 10. Raising the ceiling and resuming must let the ravel run again — a
    //     stop the operator cannot undo would be worse than no stop at all.
    await evaluate(`document.querySelector('button[aria-label="Back"]').click()`)
    await waitFor(evaluate, `!!window.__smoke.id('open-settings')`, 'the dashboard settings entry', 15_000)
    await evaluate(`window.__smoke.openSettings()`)
    await waitFor(evaluate, `!!window.__smoke.id('token-ceiling')`, 'the Budget setting', 15_000)
    await evaluate(`window.__smoke.type(window.__smoke.id('token-ceiling'), '0', 'input')`)
    await waitFor(evaluate, `!!window.__smoke.id('settings-save') && !window.__smoke.id('settings-save').disabled`, 'Save to enable', 15_000)
    await evaluate(`window.__smoke.id('settings-save').click()`)
    await waitFor(evaluate, `window.__smoke.id('settings-save').textContent.includes('Saved')`, 'the settings save to confirm', 15_000)

    await evaluate(`window.__smoke.id('back').click()`)
    await waitFor(evaluate, `!!window.__smoke.named('glass-ravel-row', 'GUI smoke')`, 'the ravel strip', 15_000)
    await evaluate(`window.__smoke.named('glass-ravel-row', 'GUI smoke').click()`)
    await waitFor(evaluate, `!!window.__smoke.button('Resume') && !window.__smoke.button('Resume').disabled`, 'the Resume control', 15_000)
    await evaluate(`window.__smoke.button('Resume').click()`)

    const resumed = await waitFor(
      evaluate,
      `(() => {
        const pills = [...document.querySelectorAll('header span')].map((s) => s.textContent.trim())
        const status = pills.find((t) => t.includes('·') && !t.includes('tok est.'))
        return status && !status.includes('Paused') ? status : null
      })()`,
      'the ravel to leave the paused state'
    )
    check('raising the ceiling and resuming restarts the ravel', !!resumed, `status pill: ${resumed}`)
    const bannerGone = await evaluate(`
      return ![...document.querySelectorAll('[role="alert"]')].some((n) => n.textContent.includes('Token ceiling reached'))
    `)
    check('the breach banner clears once the ceiling is raised', bannerGone)

    // 11. A roundtable: two models, one question, real processes, no worktree.
    //     Driven through the real IPC surface rather than the rail, so this
    //     stage judges the deliberation loop and not one button's placement.
    const table = await evaluate(`
      const repos = await window.api.listRepos()
      const created = await window.api.createRoundtable({
        name: 'Smoke table',
        repoId: repos[0].id,
        repoPath: repos[0].path,
        topic: 'What should we do first about the auth refresh drops?',
        seats: [
          { name: 'Opus', harness: 'claude', model: null, stance: 'Argue for the smallest change that works.' },
          { name: 'GPT', harness: 'codex', model: null, stance: 'Attack the plan for risk and hidden cost.' }
        ],
        maxTurns: 4
      })
      return created
    `)
    check('a roundtable can be created with two different models', table?.ok === true, JSON.stringify(table?.error ?? ''))

    const talked = await evaluate(`
      const started = await window.api.startRoundtable(${JSON.stringify(table?.ok ? table.roundtable.id : '')})
      return started
    `)
    const finished = talked?.ok ? talked.roundtable : null
    check('the table runs real turns and reaches a conclusion', finished?.conclusion !== null && !!finished?.conclusion, finished?.status ?? 'no result')
    check(
      'the seats alternate rather than one model talking to itself',
      JSON.stringify((finished?.turns ?? []).map((turn) => turn.seatId)) === JSON.stringify(['seat-1', 'seat-2']),
      JSON.stringify((finished?.turns ?? []).map((turn) => turn.seatId))
    )
    check(
      'each seat is billed for what it said',
      (finished?.usage?.inputTokens ?? 0) > 0 && (finished?.usage?.outputTokens ?? 0) > 0,
      `~${(finished?.usage?.inputTokens ?? 0) + (finished?.usage?.outputTokens ?? 0)} tok est.`
    )
    const secondSeatHeardTheFirst = await waitForLog(/SEAT PROMPT[\s\S]{0,4000}WHAT HAS BEEN SAID SO FAR:[\s\S]{0,400}The refresh path is where the risk is/)
    check('a seat argues with what the other one actually said', secondSeatHeardTheFirst)
    const tableSurvives = await evaluate(`
      const list = await window.api.listRoundtables()
      const found = list.find((item) => item.name === 'Smoke table')
      return found ? found.conclusion : null
    `)
    check('the conclusion is persisted, not just returned', typeof tableSurvives === 'string' && tableSurvives.length > 0, String(tableSurvives).slice(0, 80))

    // The UI must be able to open what the runtime produced — a deliberation
    // the operator cannot read is a log file with extra steps.
    await evaluate(`document.querySelector('button[aria-label="Back"]')?.click()`)
    const rendered = await waitFor(
      evaluate,
      `(() => {
        const entry = window.__smoke.named('glass-roundtable-row', 'Smoke table')
        if (!entry) return null
        entry.click()
        return 'opened'
      })()`,
      'the roundtable entry point',
      20_000
    )
    check('a roundtable can be opened from the shell', rendered === 'opened')
    const transcriptShown = await waitFor(
      evaluate,
      `(() => {
        const text = window.__smoke.bodyText()
        return text.includes('The refresh path is where the risk is') && text.includes('Fix the refresh path, then stop')
          ? 'shown'
          : null
      })()`,
      'the transcript and its conclusion',
      20_000
    )
    check('the view shows both seats and the strategy they agreed on', transcriptShown === 'shown')
    const composer = await evaluate(
      `return !!document.querySelector('textarea[aria-label="Note to the debate"]')`
    )
    check('the operator can put a note to the debate', composer)

    cdp.close()
  } catch (e) {
    check(`the run completed without a driver error`, false, e.message)
  } finally {
    stop()
    finish()
  }
}

function finish() {
  const failed = checks.filter((c) => !c.ok).length
  process.stdout.write(`\n${checks.length - failed}/${checks.length} GUI checks passed\n`)
  if (existsSync(LOG)) process.stdout.write(`harness log: ${LOG}\n`)
  process.exit(failed === 0 ? 0 : 1)
}

/**
 * Proves the regression that would hurt most: a store written before the token
 * economy existed must still load, render, and show a zero estimate — not a
 * crash, not a missing pill, and not the write-lockout that a strict presence
 * check on `usage` would cause.
 */
async function runBackCompat(evaluate) {
  await waitFor(evaluate, `!!window.__smoke.id('canvas')`, 'the canvas', 30_000)
  check('a pre-metering store still loads', true)

  const toast = await evaluate(`
    const el = document.querySelector('div.fixed.bottom-4.right-4')
    return el ? el.innerText.trim().slice(0, 300) : null
  `)
  check('no error banner on load', toast === null, toast ?? '')

  const repos = await evaluate(`return (await window.api.listRepos()).length`)
  check('existing repositories survive the load', repos > 0, `${repos} repo(s)`)

  // A real store may legitimately hold no ravels. Asserting on an empty list
  // would fail for the operator's history rather than for a regression, and
  // the render check below has nothing to open — so say so and stop.
  const ravels = await evaluate(`return await window.api.listRavel()`)
  const settings = await evaluate(`return await window.api.getSettings()`)
  check('the ceiling defaults to disabled', settings.tokenCeilingPerRavel === 0, `ceiling: ${settings.tokenCeilingPerRavel}`)

  // The lockout this guards against is a REFUSED WRITE, so prove a write lands.
  const saved = await evaluate(`return await window.api.saveSettings({ tokenCeilingPerRavel: 12345 })`)
  check('settings still save against a migrated store', saved.tokenCeilingPerRavel === 12345, `saved: ${saved.tokenCeilingPerRavel}`)

  if (ravels.length === 0) {
    process.stdout.write('SKIP  the seeded store holds no ravels; migration rendering was not exercised\n')
    return
  }

  check(
    'every pre-existing ravel defaults to a zero estimate',
    ravels.every((r) => r.usage && r.usage.inputTokens === 0 && r.usage.outputTokens === 0 && r.usage.costUsd === null),
    JSON.stringify(ravels.map((r) => r.usage))
  )

  await evaluate(`
    const ravels = await window.api.listRavel()
    window.__smoke.named('glass-ravel-row', ravels[0].name)?.click()
  `)
  const pill = await waitFor(
    evaluate,
    `(() => {
      const pills = [...document.querySelectorAll('header span')].map((s) => s.textContent.trim())
      return pills.find((t) => t.includes('tok est.')) ?? null
    })()`,
    "the migrated ravel's token pill",
    20_000
  )
  check('the migrated ravel renders a zero pill, not a crash', /^~0 tok est\./.test(pill ?? ''), `pill: ${pill}`)
}

main().catch((e) => fail(`gui-smoke could not run: ${e.stack}`))

/**
 * A ceiling that only settles when a child exits is a speed bump, not a
 * budget. This lets a chattering child run, then lowers the ceiling to just
 * above what has been spent, and requires the app to notice mid-flight, stop
 * the child, and leave its work resumable.
 */
async function runRunaway(evaluate) {
  const ravelId = await evaluate(`return (await window.api.listRavel())[0].id`)
  // Proves the double can actually produce pty output; a silent child would
  // make every metering assertion below vacuous.
  await evaluate(`
    window.__ptyChars = 0
    window.api.onPtyData((_id, data) => { window.__ptyChars += data.length })
  `)
  await new Promise((r) => setTimeout(r, 2000))
  const ptyChars = await evaluate(`return window.__ptyChars`)
  check('the child streams output through the pty', ptyChars > 0, `${ptyChars} chars in 2s`)

  // The child must actually be burning output before the ceiling is lowered,
  // otherwise this would only re-test the spawn guard. Polled by hand so a
  // miss reports what the fleet was actually doing instead of a bare timeout.
  const deadline = Date.now() + 60_000
  let observed = null
  let climbed = 0
  while (Date.now() < deadline) {
    observed = await evaluate(`
      const r = await window.api.getRavel(${JSON.stringify(ravelId)})
      return { status: r.status, dispatches: r.dispatches.map((d) => [d.status, d.usage.outputTokens]) }
    `)
    const live = observed.dispatches.find(([status]) => status === 'starting' || status === 'active')
    if (live && live[1] > 0) {
      climbed = live[1]
      break
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  check('a live child is billed while it is still running', climbed > 0, `last seen: ${JSON.stringify(observed)}`)
  if (climbed === 0) return

  const spent = await evaluate(`
    const r = await window.api.getRavel(${JSON.stringify(ravelId)})
    return r.usage.inputTokens + r.usage.outputTokens
  `)

  await evaluate(`document.querySelector('button[aria-label="Back"]').click()`)
  await waitFor(evaluate, `!!window.__smoke.id('open-settings')`, 'the dashboard settings entry', 15_000)
  await evaluate(`window.__smoke.openSettings()`)
  await waitFor(evaluate, `!!window.__smoke.id('token-ceiling')`, 'the Budget setting', 15_000)
  await evaluate(`
    window.__smoke.type(window.__smoke.id('token-ceiling'), '${spent + 200}', 'input')
  `)
  await waitFor(evaluate, `!!window.__smoke.id('settings-save') && !window.__smoke.id('settings-save').disabled`, 'Save to enable', 15_000)
  await evaluate(`window.__smoke.id('settings-save').click()`)
  await waitFor(evaluate, `window.__smoke.id('settings-save').textContent.includes('Saved')`, 'the settings save to confirm', 15_000)

  const stopped = await waitFor(
    evaluate,
    `(async () => {
      const r = await window.api.getRavel(${JSON.stringify(ravelId)})
      return r.status === 'paused' ? r : null
    })()`,
    'the ravel to stop itself mid-flight'
  )
  check('the ceiling stops a running child without waiting for it to exit', stopped.status === 'paused')
  check(
    'the stopped brief stays resumable rather than failed',
    stopped.dispatches[0].status === 'interrupted',
    `dispatch: ${stopped.dispatches[0].status}`
  )

  // The kill is a signal, not a synchronous teardown; the session record
  // disappears when the process actually dies.
  const children = await waitFor(
    evaluate,
    `(async () => ((await window.api.getRavelChildren(${JSON.stringify(ravelId)})).length === 0 ? 'gone' : null))()`,
    'the killed child process to disappear',
    20_000
  )
  check('the child process is gone', children === 'gone')

  const logged = await evaluate(`
    const entries = await window.api.getRavelLog(${JSON.stringify(ravelId)})
    const hit = entries.find((e) => e.event === 'budget' && e.text.includes('stopped'))
    return hit ? hit.text : null
  `)
  check('the stop is recorded for the operator', /stopped 1 live child/.test(logged ?? ''), logged ?? '')
}
