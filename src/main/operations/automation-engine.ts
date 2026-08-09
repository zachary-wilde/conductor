import type { CronSpec, EpochMs } from './types'

/**
 * Pure cron + timezone timing engine for the Operations Core automation subsystem.
 *
 * Every function is pure: time is injected as `EpochMs` and the timezone is taken
 * from the cadence. Nothing here reads the system clock, the filesystem, or any
 * module-level state — the same convention the insights subsystem uses, so timing
 * stays deterministic and unit-testable.
 *
 * DST correctness comes from `Intl.DateTimeFormat` with the cadence's IANA
 * timezone: a candidate UTC instant is converted to that zone's wall-clock fields
 * before matching, so wall times that do not exist (spring-forward) are never
 * produced and wall times that occur once (fall-back, outside the repeated hour)
 * fire exactly once.
 *
 * This module owns TIME MATH only. It returns plain numbers and arrays; it never
 * touches `Occurrence` records or state. The coalescing / single-flight logic
 * lives in the ledger, which consumes this engine's output.
 */

/** One minute in milliseconds. Cron resolves to the minute. */
const MINUTE = 60_000

/**
 * How far `nextOccurrence` will search before giving up, in minutes (~370 days).
 * That is well past a leap year, so any expression that can fire at all within a
 * year resolves. Genuinely impossible dates such as Feb 31 — or a Feb-29-only
 * expression mid-cycle — throw instead of looping forever.
 */
const SEARCH_CAP_MINUTES = 370 * 24 * 60

/** Wall-clock fields for a single minute-resolution instant. */
interface LocalFields {
  minute: number
  hour: number
  dayOfMonth: number
  month: number
  dayOfWeek: number
}

/**
 * A cron expression parsed into per-field allow-lists plus the two flags that
 * drive the day-of-month / day-of-week OR rule.
 *
 * Each field is the sorted, de-duplicated set of values it accepts.
 * `dayOfMonthRestricted` and `dayOfWeekRestricted` are true only when the
 * original field token did not contain `*` — the Vixie-cron definition of a
 * "restricted" day field. When both day fields are restricted a time matches if
 * either matches; otherwise both must match (see {@link matchesCron}).
 */
export interface ParsedCron {
  readonly minute: readonly number[]
  readonly hour: readonly number[]
  readonly dayOfMonth: readonly number[]
  readonly month: readonly number[]
  readonly dayOfWeek: readonly number[]
  readonly dayOfMonthRestricted: boolean
  readonly dayOfWeekRestricted: boolean
}

interface FieldLimits {
  readonly min: number
  readonly max: number
}

const FIELD_LIMITS: readonly FieldLimits[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day-of-month
  { min: 1, max: 12 }, // month
  { min: 0, max: 6 } // day-of-week (0 = Sunday)
]

/**
 * Parse a single cron number, rejecting anything that is not a bare non-negative
 * integer (named months/days like `JAN` are intentionally unsupported).
 */
function parseCronInt(raw: string, what: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid cron ${what} "${raw}": expected an integer`)
  }
  return Number(raw)
}

/**
 * Expand one comma-separated item into its set of allowed values, adding them
 * to `out`. An item may be a wildcard, a single value, a range, or any of those
 * with a step divisor (wildcard-with-step, range-with-step, or value-with-step).
 */
function parseItem(item: string, limits: FieldLimits, out: Set<number>): void {
  if (item === '') {
    throw new Error('Invalid cron field: empty item in list')
  }

  let step = 1
  let base = item
  const slash = item.indexOf('/')
  if (slash !== -1) {
    base = item.slice(0, slash)
    step = parseCronInt(item.slice(slash + 1), 'step')
    if (step <= 0) {
      throw new Error(`Invalid cron step "${item.slice(slash + 1)}": must be a positive integer`)
    }
  }

  let lo: number
  let hi: number
  if (base === '*') {
    lo = limits.min
    hi = limits.max
  } else {
    const dash = base.indexOf('-')
    if (dash !== -1) {
      lo = parseCronInt(base.slice(0, dash), 'range start')
      hi = parseCronInt(base.slice(dash + 1), 'range end')
    } else {
      lo = parseCronInt(base, 'value')
      // `a/n` means "from a to the field maximum, every n"; a bare `a` is a single value.
      hi = slash !== -1 ? limits.max : lo
    }
  }

  if (lo < limits.min || lo > limits.max || hi < limits.min || hi > limits.max) {
    throw new Error(
      `Cron value out of range in "${item}" (allowed ${limits.min}-${limits.max})`
    )
  }
  if (lo > hi) {
    throw new Error(`Invalid cron range "${base}": start ${lo} exceeds end ${hi}`)
  }

  for (let value = lo; value <= hi; value += step) {
    out.add(value)
  }
}

/** Parse a full cron field token into a sorted, de-duplicated array of values. */
function parseField(token: string, limits: FieldLimits): number[] {
  const out = new Set<number>()
  for (const item of token.split(',')) {
    parseItem(item, limits, out)
  }
  return [...out].sort((a, b) => a - b)
}

/**
 * Parse a standard 5-field cron expression (`minute hour day-of-month month
 * day-of-week`) into a {@link ParsedCron}.
 *
 * Supports the wildcard, comma-separated lists (`a,b`), ranges (`a-b`), and
 * step divisors (wildcard-with-step and `a-b/n`, plus the `a/n` "from a every
 * n" form). Day-of-week is 0-6 with 0 = Sunday; month is 1-12.
 *
 * Throws a descriptive `Error` on any invalid field — wrong field count, an
 * out-of-range or non-numeric value, a reversed or empty range, or a non-positive
 * step.
 */
export function parseCron(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) {
    throw new Error(
      `Cron expression must have exactly 5 fields, got ${fields.length}: "${expression}"`
    )
  }

  const limits = FIELD_LIMITS
  return {
    minute: parseField(fields[0], limits[0]),
    hour: parseField(fields[1], limits[1]),
    dayOfMonth: parseField(fields[2], limits[2]),
    month: parseField(fields[3], limits[3]),
    dayOfWeek: parseField(fields[4], limits[4]),
    dayOfMonthRestricted: !fields[2].includes('*'),
    dayOfWeekRestricted: !fields[4].includes('*')
  }
}

/**
 * Whether a wall-clock instant matches a parsed cron expression, applying the
 * classic Vixie-cron day rule.
 *
 * Minute, hour, and month must always match. For the two day fields: when BOTH
 * day-of-month and day-of-week are restricted (neither was `*`), the instant
 * matches if EITHER day field matches; otherwise both must match. That makes
 * `0 0 13 * 5` fire on the 13th OR on a Friday, while `0 0 * * 5` fires only on
 * Fridays and `0 0 13 * *` only on the 13th.
 */
export function matchesCron(
  parsed: ParsedCron,
  localFields: LocalFields
): boolean {
  const domHit = parsed.dayOfMonth.includes(localFields.dayOfMonth)
  const dowHit = parsed.dayOfWeek.includes(localFields.dayOfWeek)
  const dayOk =
    parsed.dayOfMonthRestricted && parsed.dayOfWeekRestricted
      ? domHit || dowHit
      : domHit && dowHit

  return (
    parsed.minute.includes(localFields.minute) &&
    parsed.hour.includes(localFields.hour) &&
    parsed.month.includes(localFields.month) &&
    dayOk
  )
}

/**
 * Build the {@link LocalFields} for a UTC instant as seen in a timezone, using a
 * pre-built formatter (created once per search). `dayOfWeek` (0 = Sunday) is
 * derived from the wall-clock calendar date, so it is locale-independent.
 */
function localFieldsFromParts(parts: Intl.DateTimeFormatPart[]): LocalFields {
  let year = 1970
  let month = 1
  let day = 1
  let hour = 0
  let minute = 0
  for (const part of parts) {
    switch (part.type) {
      case 'year':
        year = Number(part.value)
        break
      case 'month':
        month = Number(part.value)
        break
      case 'day':
        day = Number(part.value)
        break
      case 'hour':
        hour = Number(part.value)
        break
      case 'minute':
        minute = Number(part.value)
        break
    }
  }
  const dayOfWeek = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  return { minute, hour, dayOfMonth: day, month, dayOfWeek }
}

/**
 * The smallest epoch-ms strictly greater than `after` whose wall-clock time in
 * `cadence.timezone` matches the cron expression.
 *
 * The search steps minute-by-minute (cron's resolution) through real elapsed
 * time, starting at the minute boundary after `after` and capped at ~370 days.
 * Stepping in real time is what makes this DST-correct: on a spring-forward day
 * no real instant has the skipped wall time, so a `30 2 * * *` job simply moves
 * to the next day; on a fall-back day a wall time that exists once still fires
 * exactly once. Throws if nothing matches within the cap (e.g. an impossible
 * date like Feb 31).
 */
export function nextOccurrence(cadence: CronSpec, after: EpochMs): EpochMs {
  const parsed = parseCron(cadence.expression)
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: cadence.timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })

  const start = Math.floor((after + MINUTE) / MINUTE) * MINUTE
  const cap = start + SEARCH_CAP_MINUTES * MINUTE

  for (let candidate = start; candidate <= cap; candidate += MINUTE) {
    if (matchesCron(parsed, localFieldsFromParts(formatter.formatToParts(new Date(candidate))))) {
      return candidate
    }
  }

  throw new Error(
    `No cron match for "${cadence.expression}" in ${cadence.timezone} within ~370 days after ${after}`
  )
}

/**
 * Every cron fire time `t` with `since < t <= now`, ascending. Built by repeated
 * {@link nextOccurrence}. Returns `[]` when there is none — including the
 * `since === now` case. An expression that can never fire again simply stops the
 * enumeration rather than throwing.
 */
export function dueOccurrencesSince(
  cadence: CronSpec,
  since: EpochMs,
  now: EpochMs
): EpochMs[] {
  if (now <= since) {
    return []
  }

  const occurrences: EpochMs[] = []
  let cursor = since
  while (cursor < now) {
    let next: EpochMs
    try {
      next = nextOccurrence(cadence, cursor)
    } catch {
      break
    }
    if (next > now) {
      break
    }
    occurrences.push(next)
    cursor = next
  }

  return occurrences
}
