/**
 * Roundtable — two or three named models arguing one question to a conclusion.
 *
 * Deliberately not a Ravel. A Ravel decomposes work and dispatches children
 * into worktrees; a roundtable takes no worktree, edits nothing, and produces
 * one artifact: a strategy. It exists because deciding what to do is a
 * different job from doing it, and it is the job where a second opinion from a
 * different vendor is worth the most.
 *
 * Everything here is headless and bounded. A turn is one non-interactive
 * invocation, the table stops at `maxTurns` or when a seat concludes, and the
 * same estimated-token ceiling that stops a runaway fleet stops a runaway
 * argument.
 */
import { randomUUID } from 'node:crypto'
import { runHeadlessHarness } from './harness'
import { repoSnapshot } from './git'
import { store } from './store'
import {
  DEFAULT_ROUNDTABLE_TURNS,
  MAX_ROUNDTABLE_SEATS,
  MAX_ROUNDTABLE_TURNS,
  MAX_ROUNDTABLE_TURN_CHARS,
  MIN_ROUNDTABLE_SEATS,
  ROUNDTABLE_CONCLUSION_MARKER,
  type CreateRoundtableRequest,
  type RavelUsage,
  type RoundtableActionResult,
  type RoundtableConfig,
  type RoundtableSeat,
  type RoundtableTurn,
  type Settings
} from '@shared/types'
import { addUsage, estimateCostUsd, estimateTokens } from '@shared/pricing'

export interface RoundtableServices {
  runHeadlessHarness: typeof runHeadlessHarness
  repoSnapshot: typeof repoSnapshot
  getSettings: typeof store.getSettings
  listRoundtables: typeof store.listRoundtables
  getRoundtable: typeof store.getRoundtable
  addRoundtable: typeof store.addRoundtable
  replaceRoundtable: typeof store.replaceRoundtable
  removeRoundtable: typeof store.removeRoundtable
}

const productionServices: RoundtableServices = {
  runHeadlessHarness: (id, settings, prompt, opts) => runHeadlessHarness(id, settings, prompt, opts),
  repoSnapshot: (repoPath, limit) => repoSnapshot(repoPath, limit),
  getSettings: () => store.getSettings(),
  listRoundtables: () => store.listRoundtables(),
  getRoundtable: (id) => store.getRoundtable(id),
  addRoundtable: (cfg) => store.addRoundtable(cfg),
  replaceRoundtable: (id, cfg) => store.replaceRoundtable(id, cfg),
  removeRoundtable: (id) => store.removeRoundtable(id)
}

let svc: RoundtableServices = productionServices

/** Test seam. Pass null to restore the production dependencies. */
export function setRoundtableServicesForTest(overrides: Partial<RoundtableServices> | null): void {
  svc = overrides === null ? productionServices : { ...productionServices, ...overrides }
}

let emit: (channel: string, ...args: unknown[]) => void = () => {}

export function setRoundtableEmitter(fn: (channel: string, ...args: unknown[]) => void): void {
  emit = fn
}

/** One in-flight table at a time per id: a second run would interleave turns. */
const running = new Map<string, AbortController>()

function save(cfg: RoundtableConfig): RoundtableConfig {
  const saved = svc.replaceRoundtable(cfg.id, cfg)
  if (!saved) throw new Error(`roundtable not found: ${cfg.id}`)
  emit('roundtable:update', saved)
  return saved
}

export function listRoundtables(): RoundtableConfig[] {
  return svc.listRoundtables()
}

export function getRoundtable(id: string): RoundtableConfig | undefined {
  return svc.getRoundtable(id)
}

export function createRoundtable(req: CreateRoundtableRequest): RoundtableActionResult {
  const topic = req.topic.trim()
  if (topic.length === 0) {
    return { ok: false, error: { code: 'topic-required', message: 'A roundtable needs a question to answer.' } }
  }
  if (req.seats.length < MIN_ROUNDTABLE_SEATS || req.seats.length > MAX_ROUNDTABLE_SEATS) {
    return {
      ok: false,
      error: {
        code: 'seat-count',
        message: `A roundtable seats ${MIN_ROUNDTABLE_SEATS} to ${MAX_ROUNDTABLE_SEATS} models.`
      }
    }
  }
  const seats: RoundtableSeat[] = req.seats.map((seat, index) => ({
    id: `seat-${index + 1}`,
    name: seat.name.trim() || `Seat ${index + 1}`,
    harness: seat.harness,
    model: seat.model?.trim() ? seat.model.trim() : null,
    stance: seat.stance.trim()
  }))
  // Two seats with the same model is a mirror, not a conversation. It is
  // allowed — the operator may want the same model in two stances — but it is
  // worth being explicit that the value is in the difference.
  const cfg: RoundtableConfig = {
    id: randomUUID(),
    name: req.name.trim() || 'Roundtable',
    repoId: req.repoId,
    repoPath: req.repoPath,
    topic,
    seats,
    turns: [],
    maxTurns: clampTurns(req.maxTurns),
    status: 'idle',
    conclusion: null,
    error: null,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: null },
    createdAt: Date.now()
  }
  const saved = svc.addRoundtable(cfg)
  emit('roundtable:update', saved)
  return { ok: true, roundtable: saved }
}

function clampTurns(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_ROUNDTABLE_TURNS
  return Math.min(MAX_ROUNDTABLE_TURNS, Math.max(2, Math.round(value)))
}

/**
 * The operator's own contribution. The table is a conversation and the
 * operator is at it — a note is just another turn, seen by every seat that
 * speaks after it.
 */
export function addNote(id: string, body: string): RoundtableActionResult {
  const cfg = svc.getRoundtable(id)
  if (!cfg) return { ok: false, error: { code: 'unknown-roundtable', message: 'No such roundtable.' } }
  const text = body.trim()
  if (text.length === 0) {
    return { ok: false, error: { code: 'body-required', message: 'A note needs a body.' } }
  }
  const turn: RoundtableTurn = {
    id: randomUUID(),
    seatId: null,
    body: text.slice(0, MAX_ROUNDTABLE_TURN_CHARS),
    createdAt: Date.now(),
    usage: { inputTokens: 0, outputTokens: 0, costUsd: null }
  }
  return { ok: true, roundtable: save({ ...cfg, turns: [...cfg.turns, turn], error: null }) }
}

export function pauseRoundtable(id: string): RoundtableActionResult {
  const cfg = svc.getRoundtable(id)
  if (!cfg) return { ok: false, error: { code: 'unknown-roundtable', message: 'No such roundtable.' } }
  running.get(id)?.abort()
  running.delete(id)
  if (cfg.status !== 'running') return { ok: true, roundtable: cfg }
  return { ok: true, roundtable: save({ ...cfg, status: 'paused' }) }
}

export function deleteRoundtable(id: string): void {
  running.get(id)?.abort()
  running.delete(id)
  svc.removeRoundtable(id)
  emit('roundtable:removed', id)
}

/**
 * Run the table until it concludes, hits its turn cap, crosses the token
 * ceiling, or is paused. Resolves when the table stops; the UI follows along
 * through `roundtable:update`.
 */
export async function runRoundtable(id: string, settings: Settings): Promise<RoundtableActionResult> {
  const existing = svc.getRoundtable(id)
  if (!existing) return { ok: false, error: { code: 'unknown-roundtable', message: 'No such roundtable.' } }
  if (running.has(id)) {
    return { ok: false, error: { code: 'already-running', message: 'This roundtable is already talking.' } }
  }
  if (existing.conclusion !== null) {
    return { ok: false, error: { code: 'already-concluded', message: 'This roundtable already reached a conclusion.' } }
  }
  const abort = new AbortController()
  running.set(id, abort)
  let cfg = save({ ...existing, status: 'running', error: null })
  // Taken once, before the first turn: every seat argues about the same
  // repository, and a snapshot that shifted mid-argument would make the
  // transcript unreadable.
  const snapshot = await safeSnapshot(cfg.repoPath)

  try {
    while (cfg.turns.filter((turn) => turn.seatId !== null).length < cfg.maxTurns) {
      if (abort.signal.aborted) break
      const ceiling = settings.tokenCeilingPerRavel
      if (ceiling > 0 && cfg.usage.inputTokens + cfg.usage.outputTokens >= ceiling) {
        cfg = save({
          ...cfg,
          status: 'paused',
          error: `Paused at the token ceiling: ~${cfg.usage.inputTokens + cfg.usage.outputTokens} of ${ceiling} estimated tokens used.`
        })
        return { ok: true, roundtable: cfg }
      }

      const seat = nextSeat(cfg)
      const prompt = seatPrompt(cfg, seat, snapshot)
      let body: string
      try {
        body = await svc.runHeadlessHarness(seat.harness, settings, prompt, {
          model: seat.model,
          cwd: cfg.repoPath,
          signal: abort.signal
        })
      } catch (e) {
        cfg = save({ ...cfg, status: 'error', error: `${seat.name} could not speak: ${msg(e)}` })
        return { ok: true, roundtable: cfg }
      }
      if (abort.signal.aborted) break

      const spoken = body.trim().slice(0, MAX_ROUNDTABLE_TURN_CHARS)
      const usage = turnUsage(seat.model, prompt.length, spoken.length)
      const turn: RoundtableTurn = {
        id: randomUUID(),
        seatId: seat.id,
        body: spoken.length > 0 ? spoken : '(said nothing)',
        createdAt: Date.now(),
        usage
      }
      const conclusion = conclusionFrom(spoken)
      cfg = save({
        ...cfg,
        turns: [...cfg.turns, turn],
        usage: addUsage(cfg.usage, usage),
        conclusion,
        status: conclusion === null ? 'running' : 'concluded'
      })
      if (conclusion !== null) return { ok: true, roundtable: cfg }
    }

    // Out of turns without agreement. That is a real outcome, not a failure:
    // two models that cannot converge in the budget they were given have told
    // the operator something worth knowing.
    const stopped = svc.getRoundtable(id) ?? cfg
    const status = abort.signal.aborted ? 'paused' : 'concluded'
    cfg = save({
      ...stopped,
      status,
      error:
        status === 'concluded' && stopped.conclusion === null
          ? 'The table used every turn without agreeing on a conclusion.'
          : stopped.error
    })
    return { ok: true, roundtable: cfg }
  } finally {
    running.delete(id)
  }
}

async function safeSnapshot(repoPath: string): Promise<string> {
  try {
    return await svc.repoSnapshot(repoPath, 10)
  } catch {
    return '(repository state unavailable)'
  }
}

/** Strict round-robin: whoever has spoken least recently speaks next. */
function nextSeat(cfg: RoundtableConfig): RoundtableSeat {
  const spoken = cfg.turns.filter((turn) => turn.seatId !== null)
  if (spoken.length === 0) return cfg.seats[0]
  const lastSeatId = spoken[spoken.length - 1].seatId
  const index = cfg.seats.findIndex((seat) => seat.id === lastSeatId)
  return cfg.seats[(index + 1) % cfg.seats.length]
}

function conclusionFrom(body: string): string | null {
  const marker = body.lastIndexOf(ROUNDTABLE_CONCLUSION_MARKER)
  if (marker === -1) return null
  const text = body.slice(marker + ROUNDTABLE_CONCLUSION_MARKER.length).trim()
  return text.length === 0 ? null : text
}

function turnUsage(model: string | null, inputChars: number, outputChars: number): RavelUsage {
  const inputTokens = estimateTokens(inputChars)
  const outputTokens = estimateTokens(outputChars)
  return { inputTokens, outputTokens, costUsd: estimateCostUsd(model, inputTokens, outputTokens) }
}

/**
 * Everything a seat is given, and nothing else.
 *
 * A roundtable is the one place in Conductor where agents deliberately see each
 * other's words — that is the entire point of it — but the boundary still
 * holds outward: a seat sees this table's topic, this repository's state and
 * this transcript. It never sees another roundtable, a Ravel's mission, or any
 * brief.
 */
function seatPrompt(cfg: RoundtableConfig, seat: RoundtableSeat, snapshot: string): string {
  const others = cfg.seats.filter((other) => other.id !== seat.id).map((other) => other.name)
  const spoken = cfg.turns.filter((turn) => turn.seatId !== null).length
  const remaining = Math.max(0, cfg.maxTurns - spoken)
  const lines = [
    `You are ${seat.name}, one of ${cfg.seats.length} at a roundtable with ${others.join(' and ')}.`,
    'You are here to decide what should be done, not to do it. You have no tools,',
    'no worktree, and no ability to edit anything.',
    ''
  ]
  if (seat.stance.length > 0) lines.push(`YOUR STANCE: ${seat.stance}`, '')
  lines.push(
    'QUESTION PUT TO THE TABLE:',
    cfg.topic,
    '',
    'REPOSITORY AS IT STANDS:',
    snapshot,
    ''
  )
  if (cfg.turns.length === 0) {
    lines.push('You speak first. Open with your reading of the situation and what you would do.')
  } else {
    lines.push('WHAT HAS BEEN SAID SO FAR:', transcript(cfg), '')
    lines.push('Answer what was actually said. Disagree where you disagree — a')
    lines.push('roundtable that agrees immediately was a waste of a seat.')
  }
  lines.push(
    '',
    `Turns left at this table: ${remaining}. Keep your contribution under 300 words.`,
    `When the table has genuinely settled, end your turn with "${ROUNDTABLE_CONCLUSION_MARKER}"`,
    'followed by the agreed strategy: what to do, in what order, and what to leave alone.',
    'Do not conclude just because you are running out of turns — say plainly that',
    'you have not converged and why.'
  )
  return lines.join('\n')
}

function transcript(cfg: RoundtableConfig): string {
  const nameFor = new Map(cfg.seats.map((seat) => [seat.id, seat.name]))
  return cfg.turns
    .map((turn) => `${turn.seatId === null ? 'THE OPERATOR' : (nameFor.get(turn.seatId) ?? 'A seat')}:\n${turn.body}`)
    .join('\n\n')
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
