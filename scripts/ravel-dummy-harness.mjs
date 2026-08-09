/**
 * Deterministic stand-in for a real coding harness (Claude/Codex/omp).
 *
 * It spends no AI quota: it records what Conductor gives it and emits fixed
 * `conductor-tool` blocks.
 *
 * Since the manager became a headless per-turn invocation, this script CAN now
 * drive the whole orchestration loop for free. A manager turn is an ordinary
 * child process with piped stdio — not a pty — so the prompt actually arrives,
 * either on ARGV (omp-style print mode) or on stdin (claude/codex print mode).
 * The previously documented ConPTY limitation only ever applied to the old
 * persistent manager session; children are still launched in a pty and are
 * still prompted by ARGV.
 *
 * What a run proves, for free:
 *   - harness resolution, headless args, `--model`, and env reach a real spawn
 *   - clarify -> propose -> approve -> dispatch -> child-exit -> complete
 *   - a child's scoped brief arrives intact on ARGV and contains no mission or
 *     conversation text
 *   - Ravel creation, store isolation, and worktree/branch creation
 *
 * Usage (PowerShell, from the repo root):
 *
 *   $env:CONDUCTOR_SMOKE_USER_DATA = "$PWD\.tmp\ravel-smoke-user-data"
 *   $env:CONDUCTOR_RAVEL_DUMMY_HARNESS = "$PWD\scripts\ravel-dummy-harness.mjs"
 *   $env:CONDUCTOR_RAVEL_DUMMY_LOG = "$PWD\.tmp\ravel-smoke.log"
 *   npm run dev
 *
 * Then create a Ravel with the instruction "this is vague" to exercise the
 * clarification path, answer it, approve the plan, and read the log named by
 * CONDUCTOR_RAVEL_DUMMY_LOG: it records ARGV, every prompt, and every emission.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'

const logFile = process.env.CONDUCTOR_RAVEL_DUMMY_LOG
if (!logFile) {
  process.stderr.write('ravel-dummy-harness: CONDUCTOR_RAVEL_DUMMY_LOG is required\n')
  process.exit(2)
}
mkdirSync(dirname(logFile), { recursive: true })

const argv = process.argv.slice(2)

/**
 * Conductor always pushes the prompt LAST (harness.ts:74), and `--model` is the
 * only value-taking flag it emits. The previous "any arg after a `--` flag is a
 * flag value" heuristic silently swallowed the child prompt, because a child is
 * launched as `--dangerously-skip-permissions <prompt>` and that flag is
 * boolean. The child then fell through to the manager branch and never logged a
 * CHILD PROMPT, so verify-smoke-log.mjs could not see a correctly-delivered
 * brief.
 */
const lastArg = argv[argv.length - 1]
const argvPrompt =
  lastArg !== undefined && !lastArg.startsWith('-') && argv[argv.length - 2] !== '--model'
    ? lastArg
    : ''

function log(role, section, body) {
  appendFileSync(logFile, `\n--- ${role} ${section} @ ${new Date().toISOString()} ---\n${body}\n`, 'utf8')
}

function emit(role, call) {
  const block = '```conductor-tool\n' + JSON.stringify(call) + '\n```\n'
  log(role, 'EMIT', block)
  process.stdout.write(block)
}

log('HARNESS', 'ARGV', JSON.stringify(argv, null, 2))

/**
 * A child is prompted on ARGV and only has to prove what it received; it never
 * drives the protocol.
 *
 * Lifetime is explicit rather than incidental. By default it does its work,
 * stays briefly so a message_child write can land, then exits like a real
 * agent finishing a brief. With CONDUCTOR_RAVEL_DUMMY_CHATTER it instead keeps
 * talking forever, which is what a runaway looks like to the metering path.
 */
if (argvPrompt.includes('ROLE:')) {
  log('CHILD', 'PROMPT', argvPrompt)
  // Reading stdin comes FIRST. Everything below blocks the event loop for a
  // few hundred milliseconds, and a directive that arrives in that window must
  // not be missed — a real child is listening the whole time it works.
  process.stdin.resume()
  process.stdin.setEncoding('utf8')
  // Under ConPTY stdin is a console handle: without raw mode the runtime waits
  // for line-discipline events that never come, so a directive written to the
  // pty is echoed on screen and never delivered to the script. A real CLI puts
  // its terminal in raw mode for its own TUI, which is why they receive it.
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  // Mirrors what a real child is told to do, so the report handoff is exercised.
  mkdirSync(join(process.cwd(), '.conductor'), { recursive: true })
  writeFileSync(join(process.cwd(), '.conductor', 'report.md'), 'DUMMY REPORT: touched nothing\n', 'utf8')
  // A child that commits nothing makes every landing an "already contained"
  // no-op, which proves the plumbing and nothing about a real merge. One real
  // commit on the branch is what makes the landing check mean something.
  try {
    writeFileSync(join(process.cwd(), 'dummy-change.txt'), `dummy child wrote this at ${Date.now()}\n`, 'utf8')
    execFileSync('git', ['add', 'dummy-change.txt'], { cwd: process.cwd(), stdio: 'ignore' })
    execFileSync('git', ['commit', '-m', 'dummy child change'], { cwd: process.cwd(), stdio: 'ignore' })
    log('CHILD', 'COMMIT', 'committed dummy-change.txt')
  } catch (e) {
    log('CHILD', 'COMMIT-FAILED', String(e))
  }
  process.stdout.write('dummy child ready\n')
  if (process.env.CONDUCTOR_RAVEL_DUMMY_CHATTER) {
    log('CHILD', 'CHATTER', 'enabled')
    process.stdin.on('data', (chunk) => log('CHILD', 'STDIN', chunk))
    let tick = 0
    setInterval(() => {
      tick += 1
      process.stdout.write(`dummy child working: step ${tick} ${'.'.repeat(200)}\n`)
    }, 50)
  } else {
    // A real child works until it is done, which is what makes it steerable at
    // all. Exiting on a fixed one-second timer made every directive a race the
    // driver lost, so the child now waits for one and leaves shortly after —
    // or gives up on its own if nothing ever arrives.
    const idleMs = Number(process.env.CONDUCTOR_RAVEL_DUMMY_CHILD_MS ?? 12_000)
    const leave = () => {
      process.stdout.write('dummy child done\n')
      process.exit(0)
    }
    let timer = setTimeout(leave, idleMs)
    process.stdin.on('data', (chunk) => {
      log('CHILD', 'STDIN', chunk)
      clearTimeout(timer)
      timer = setTimeout(leave, 300)
    })
  }
} else if (argvPrompt.length > 0) {
  runManagerTurn(argvPrompt)
} else {
  readStdin().then(runManagerTurn)
}

function readStdin() {
  return new Promise((resolve) => {
    let text = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      text += chunk
    })
    process.stdin.on('end', () => resolve(text))
  })
}

/**
 * One headless turn: read the prompt, emit what the event calls for, exit.
 *
 * A roundtable seat is the one prompt that wants prose rather than tool calls,
 * so it is answered before the manager protocol is considered at all.
 */
function runManagerTurn(prompt) {
  if (prompt.includes('at a roundtable')) return takeSeat(prompt)
  log('MANAGER', 'PROMPT', prompt)
  const directive = section(prompt, '=== THIS TURN ===')
  const sourceMessageId = /sourceMessageId:\s*(\S+)/.exec(directive)?.[1] ?? null
  const hasPlan = !prompt.includes('(no plan yet)')

  if (directive.includes('the user approved plan revision')) {
    emit('MANAGER', { tool: 'spawn_child', briefId: 'brief-1' })
    return
  }
  if (directive.includes('child for brief brief-1 completed')) {
    emit('MANAGER', { tool: 'complete', summary: 'Smoke dispatch finished.' })
    return
  }
  // The steer directive names the child, so the reply proves the manager — not
  // the operator — is what reached that session.
  const steeredChild = /the operator wants the child working on brief \S+ redirected\.\s*\r?\nchildId:\s*(\S+)/.exec(directive)?.[1]
  if (steeredChild) {
    emit('MANAGER', { tool: 'message_child', childId: steeredChild, body: 'Narrow the change to the refresh path.' })
    return
  }
  if (directive.includes('vague')) {
    emit('MANAGER', {
      tool: 'ask_clarification',
      question: 'Which target branch should Ravel use?',
      options: ['main', 'develop']
    })
    return
  }
  if (sourceMessageId && !hasPlan) {
    emit('MANAGER', proposal(sourceMessageId))
    return
  }
  emit('MANAGER', { tool: 'reply', body: 'Nothing to do for this event.' })
}

/** Propose on the first turn, converge on the second — enough to exercise both paths. */
function takeSeat(prompt) {
  log('SEAT', 'PROMPT', prompt)
  const heardSomething = prompt.includes('WHAT HAS BEEN SAID SO FAR')
  const body = heardSomething
    ? 'That holds up. Nothing else is worth doing first.\n\nCONCLUSION: Fix the refresh path, then stop.'
    : 'The refresh path is where the risk is. Start there and keep the change small.'
  log('SEAT', 'SAID', body)
  process.stdout.write(`${body}\n`)
}

/** Everything after a section header, which is where the per-turn directive lives. */
function section(text, header) {
  const start = text.indexOf(header)
  return start === -1 ? '' : text.slice(start + header.length)
}

function proposal(sourceMessageId) {
  return {
    tool: 'propose_plan',
    sourceMessageIds: [sourceMessageId],
    mission: {
      goal: 'Smoke Ravel dispatch',
      context: ['Dummy smoke run'],
      constraints: ['No paid AI'],
      acceptanceCriteria: ['Child prompt is scoped'],
      assumptions: []
    },
    briefs: [
      {
        id: 'brief-1',
        title: 'Scoped smoke child',
        role: 'lead-engineer',
        harness: 'claude',
        phase: 'implementation',
        goal: 'Echo scoped task',
        relevantContext: ['smoke fixture'],
        constraints: ['Do not inspect the full conversation'],
        acceptanceCriteria: ['Prompt contains this brief only'],
        doNotTouch: ['real repo files'],
        expectedOutput: 'Recorded stdin',
        escalationConditions: ['Missing brief'],
        dependsOn: [],
        contextExceptionReason: null
      }
    ]
  }
}
