/**
 * Judges a Ravel smoke-run log produced by scripts/ravel-dummy-harness.mjs.
 *
 * A smoke run is only evidence if something checks it. This asserts the full
 * loop happened AND that the context boundary held, then exits non-zero so it
 * can gate a release the same way a test would.
 *
 * Exit 0 = every check passed, 1 = a check failed, 2 = operator error (bad
 * arguments or an unreadable log). Never conflate the last two: a typo'd path
 * that exited 1 would read as a context-boundary regression.
 *
 * Usage: node scripts/verify-smoke-log.mjs <path-to-log>
 */
import { readFileSync } from 'node:fs'

const path = process.argv[2]
if (!path) {
  process.stderr.write('usage: node scripts/verify-smoke-log.mjs <log>\n')
  process.exit(2)
}

let log
try {
  log = readFileSync(path, 'utf8')
} catch (e) {
  process.stderr.write(`cannot read log ${path}: ${e.message}\n`)
  process.exit(2)
}

const managerPrompts = log.split('\n--- MANAGER PROMPT @').length - 1
const childPrompts = log.split('\n--- CHILD PROMPT @').length - 1

/**
 * Does any block of this kind contain `needle`?
 *
 * Every assertion goes through here because whole-log `log.includes` is a
 * tautology for anything the manager also writes down. The brief goal, for
 * one, reaches the log inside the `propose_plan` EMIT payload
 * (ravel-dummy-harness.mjs:139) — so an unscoped check passes even when the
 * brief never reached the child, which is the exact context-boundary bug this
 * verifier exists to catch. Note it is `propose_plan` and not `spawn_child`:
 * the spawn payload is only `{tool,briefId}` and carries no goal text.
 */
function promptsInclude(marker, needle) {
  return log
    .split(`\n--- ${marker} @`)
    .slice(1)
    .some((block) => block.split('\n--- ')[0].includes(needle))
}

const checks = [
  ['manager was invoked at least three times (message, approval, child exit)', managerPrompts >= 3],
  ['manager emitted ask_clarification', promptsInclude('MANAGER EMIT', '"tool":"ask_clarification"')],
  ['manager emitted propose_plan', promptsInclude('MANAGER EMIT', '"tool":"propose_plan"')],
  ['manager emitted spawn_child', promptsInclude('MANAGER EMIT', '"tool":"spawn_child"')],
  ['manager emitted complete', promptsInclude('MANAGER EMIT', '"tool":"complete"')],
  [`exactly one child was prompted (saw ${childPrompts})`, childPrompts === 1],
  ['child prompt carried its role', promptsInclude('CHILD PROMPT', 'ROLE: Lead Engineer')],
  ['child prompt carried its brief goal', promptsInclude('CHILD PROMPT', 'Echo scoped task')],
  ['child prompt asked for a report', promptsInclude('CHILD PROMPT', '.conductor/report.md')],
  ['manager prompt never carried a brief body', !promptsInclude('MANAGER PROMPT', 'Echo scoped task')],
  ['child prompt never carried the mission', !promptsInclude('CHILD PROMPT', 'Smoke Ravel dispatch')]
]

process.stdout.write(`checking ${path}\n`)
let failed = 0
for (const [label, ok] of checks) {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n`)
  if (!ok) failed += 1
}
process.stdout.write(`\n${checks.length - failed}/${checks.length} checks passed\n`)
process.exit(failed === 0 ? 0 : 1)
