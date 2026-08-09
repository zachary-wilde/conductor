import { describe, expect, it } from 'vitest'
import {
  dueOccurrencesSince,
  matchesCron,
  nextOccurrence,
  parseCron
} from './automation-engine'
import type { CronSpec } from './types'

/** Fixed epoch-ms for a UTC instant. Never reads the system clock. */
const utc = (year: number, month: number, day: number, hour: number, minute: number): number =>
  Date.UTC(year, month - 1, day, hour, minute)

const cadence = (expression: string, timezone = 'America/Toronto'): CronSpec => ({
  expression,
  timezone
})

describe('parseCron', () => {
  it('expands a wildcard into the full range for each field', () => {
    const parsed = parseCron('* * * * *')
    expect(parsed.minute).toHaveLength(60)
    expect(parsed.minute[0]).toBe(0)
    expect(parsed.minute[59]).toBe(59)
    expect(parsed.hour).toHaveLength(24)
    expect(parsed.dayOfMonth).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31])
    expect(parsed.month).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(parsed.dayOfWeek).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(parsed.dayOfMonthRestricted).toBe(false)
    expect(parsed.dayOfWeekRestricted).toBe(false)
  })

  it('parses comma-separated lists', () => {
    expect(parseCron('5,10,15 * * * *').minute).toEqual([5, 10, 15])
  })

  it('parses inclusive ranges', () => {
    expect(parseCron('1-5 * * * *').minute).toEqual([1, 2, 3, 4, 5])
  })

  it('parses wildcard steps */n', () => {
    expect(parseCron('*/15 * * * *').minute).toEqual([0, 15, 30, 45])
  })

  it('parses ranged steps a-b/n', () => {
    expect(parseCron('10-30/5 * * * *').minute).toEqual([10, 15, 20, 25, 30])
  })

  it('deduplicates and sorts overlapping list members', () => {
    expect(parseCron('5,1-3,3 * * * *').minute).toEqual([1, 2, 3, 5])
  })

  it('marks day-of-week as restricted when not a wildcard', () => {
    const weekly = parseCron('0 0 * * 5')
    expect(weekly.dayOfWeek).toEqual([5])
    expect(weekly.dayOfMonthRestricted).toBe(false)
    expect(weekly.dayOfWeekRestricted).toBe(true)
  })

  it('marks day-of-month as restricted when not a wildcard', () => {
    const monthly = parseCron('0 0 13 * *')
    expect(monthly.dayOfMonth).toEqual([13])
    expect(monthly.dayOfMonthRestricted).toBe(true)
    expect(monthly.dayOfWeekRestricted).toBe(false)
  })

  it('throws on minute out of range', () => {
    expect(() => parseCron('60 * * * *')).toThrow(/out of range/)
  })

  it('throws on hour out of range', () => {
    expect(() => parseCron('* 24 * * *')).toThrow(/out of range/)
  })

  it('throws on day-of-month out of range', () => {
    expect(() => parseCron('* * 0 * *')).toThrow(/out of range/)
    expect(() => parseCron('* * 32 * *')).toThrow(/out of range/)
  })

  it('throws on month out of range', () => {
    expect(() => parseCron('* * * 13 *')).toThrow(/out of range/)
  })

  it('throws on day-of-week out of range (0-6 only)', () => {
    expect(() => parseCron('* * * * 7')).toThrow(/out of range/)
  })

  it('throws on a non-positive step', () => {
    expect(() => parseCron('*/0 * * * *')).toThrow(/positive integer/)
  })

  it('throws on a reversed range', () => {
    expect(() => parseCron('5-1 * * * *')).toThrow(/exceeds end/)
  })

  it('throws on non-numeric (named) values', () => {
    expect(() => parseCron('MON * * * *')).toThrow(/expected an integer/)
  })

  it('throws on the wrong number of fields', () => {
    expect(() => parseCron('* * * *')).toThrow(/exactly 5 fields/)
    expect(() => parseCron('* * * * * *')).toThrow(/exactly 5 fields/)
    expect(() => parseCron('')).toThrow(/exactly 5 fields/)
  })
})

describe('matchesCron', () => {
  it('matches minute, hour, and month fields', () => {
    const parsed = parseCron('30 9 * 6 *')
    expect(matchesCron(parsed, { minute: 30, hour: 9, dayOfMonth: 15, month: 6, dayOfWeek: 6 })).toBe(true)
    expect(matchesCron(parsed, { minute: 31, hour: 9, dayOfMonth: 15, month: 6, dayOfWeek: 6 })).toBe(false)
    expect(matchesCron(parsed, { minute: 30, hour: 10, dayOfMonth: 15, month: 6, dayOfWeek: 6 })).toBe(false)
    expect(matchesCron(parsed, { minute: 30, hour: 9, dayOfMonth: 15, month: 7, dayOfWeek: 6 })).toBe(false)
  })

  describe('day-of-month / day-of-week OR rule', () => {
    // 0 0 13 * 5 — both day fields restricted: fire on the 13th OR on a Friday.
    const both = parseCron('0 0 13 * 5')

    it('matches when only day-of-month matches (13th, Wednesday)', () => {
      expect(matchesCron(both, { minute: 0, hour: 0, dayOfMonth: 13, month: 6, dayOfWeek: 3 })).toBe(true)
    })

    it('matches when only day-of-week matches (14th, Friday)', () => {
      expect(matchesCron(both, { minute: 0, hour: 0, dayOfMonth: 14, month: 6, dayOfWeek: 5 })).toBe(true)
    })

    it('matches when both match (Friday the 13th)', () => {
      expect(matchesCron(both, { minute: 0, hour: 0, dayOfMonth: 13, month: 6, dayOfWeek: 5 })).toBe(true)
    })

    it('does not match when neither matches (14th, Wednesday)', () => {
      expect(matchesCron(both, { minute: 0, hour: 0, dayOfMonth: 14, month: 6, dayOfWeek: 3 })).toBe(false)
    })
  })

  it('uses AND when only day-of-week is restricted (every Friday)', () => {
    const weekly = parseCron('0 0 * * 5')
    expect(matchesCron(weekly, { minute: 0, hour: 0, dayOfMonth: 14, month: 6, dayOfWeek: 5 })).toBe(true)
    expect(matchesCron(weekly, { minute: 0, hour: 0, dayOfMonth: 14, month: 6, dayOfWeek: 3 })).toBe(false)
  })

  it('uses AND when only day-of-month is restricted (every 13th)', () => {
    const monthly = parseCron('0 0 13 * *')
    expect(matchesCron(monthly, { minute: 0, hour: 0, dayOfMonth: 13, month: 6, dayOfWeek: 5 })).toBe(true)
    expect(matchesCron(monthly, { minute: 0, hour: 0, dayOfMonth: 14, month: 6, dayOfWeek: 5 })).toBe(false)
  })
})

describe('nextOccurrence', () => {
  it('finds the next daily occurrence in America/Toronto (EDT)', () => {
    // 2024-06-15T13:00Z is 9:00 AM EDT. Next 9:30 AM EDT is 13:30Z the same day.
    const after = utc(2024, 6, 15, 13, 0)
    expect(nextOccurrence(cadence('30 9 * * *'), after)).toBe(utc(2024, 6, 15, 13, 30))
  })

  it('rolls to the next day when the time has already passed', () => {
    // 2024-06-15T14:00Z is 10:00 AM EDT; the next 9:30 AM is the following morning.
    const after = utc(2024, 6, 15, 14, 0)
    expect(nextOccurrence(cadence('30 9 * * *'), after)).toBe(utc(2024, 6, 16, 13, 30))
  })

  it('finds the next weekly occurrence in America/Toronto', () => {
    // 2024-06-15 is a Saturday. The next Monday midnight EDT is 2024-06-17T04:00Z.
    const after = utc(2024, 6, 15, 12, 0)
    expect(nextOccurrence(cadence('0 0 * * 1'), after)).toBe(utc(2024, 6, 17, 4, 0))
  })

  it('is strictly greater than `after`', () => {
    // `after` itself sits exactly on a fire boundary; the result must be the next one.
    const after = utc(2024, 6, 15, 13, 30) // 9:30 AM EDT — a fire time
    expect(nextOccurrence(cadence('30 9 * * *'), after)).toBe(utc(2024, 6, 16, 13, 30))
  })

  describe('daylight saving', () => {
    it('skips a wall time that does not exist on spring-forward day', () => {
      // 2024-03-10: Toronto springs forward 2:00->3:00 AM EST, so 2:30 AM never occurs.
      // From 1:00 AM EST (06:00Z) the next 2:30 is 2024-03-11 2:30 AM EDT (06:30Z).
      const after = utc(2024, 3, 10, 6, 0)
      const result = nextOccurrence(cadence('30 2 * * *'), after)
      expect(result).toBe(utc(2024, 3, 11, 6, 30))
      // Sanity: nothing on the spring-forward day itself.
      expect(result).toBeGreaterThan(utc(2024, 3, 10, 7, 0))
    })

    it('fires exactly once on fall-back day', () => {
      // 2024-11-03: Toronto falls back 2:00->1:00 AM EDT. 2:30 AM exists once (in EST),
      // at 07:30Z. From 2:00 AM EST (07:00Z) the next 2:30 is 07:30Z — not a second time.
      const after = utc(2024, 11, 3, 7, 0)
      expect(nextOccurrence(cadence('30 2 * * *'), after)).toBe(utc(2024, 11, 3, 7, 30))
    })
  })

  it('throws when no match exists within the search cap', () => {
    // Feb 31 is impossible; nothing ever matches.
    expect(() => nextOccurrence(cadence('0 0 31 2 *'), utc(2024, 1, 1, 0, 0))).toThrow(/No cron match/)
  })
})

describe('dueOccurrencesSince', () => {
  it('counts missed fire times across a multi-hour downtime window', () => {
    // Hourly at :00 in UTC; downtime 10:00 -> 15:00 fires at 11,12,13,14,15 = 5 times.
    const since = utc(2024, 6, 15, 10, 0)
    const now = utc(2024, 6, 15, 15, 0)
    expect(dueOccurrencesSince(cadence('0 * * * *', 'UTC'), since, now)).toEqual([
      utc(2024, 6, 15, 11, 0),
      utc(2024, 6, 15, 12, 0),
      utc(2024, 6, 15, 13, 0),
      utc(2024, 6, 15, 14, 0),
      utc(2024, 6, 15, 15, 0)
    ])
  })

  it('returns the boundaries correctly (since < t <= now)', () => {
    // A fire time exactly at `since` is excluded; one exactly at `now` is included.
    const since = utc(2024, 6, 15, 11, 0) // a fire time itself
    const now = utc(2024, 6, 15, 13, 0)
    expect(dueOccurrencesSince(cadence('0 * * * *', 'UTC'), since, now)).toEqual([
      utc(2024, 6, 15, 12, 0),
      utc(2024, 6, 15, 13, 0)
    ])
  })

  it('returns an empty array when since === now', () => {
    const t = utc(2024, 6, 15, 12, 0)
    expect(dueOccurrencesSince(cadence('0 * * * *', 'UTC'), t, t)).toEqual([])
  })

  it('returns an empty array when now < since', () => {
    expect(
      dueOccurrencesSince(cadence('0 * * * *', 'UTC'), utc(2024, 6, 15, 15, 0), utc(2024, 6, 15, 10, 0))
    ).toEqual([])
  })

  it('returns an empty array when no fire time falls in the window', () => {
    // Daily at midnight UTC; a 30-minute afternoon window catches nothing.
    expect(
      dueOccurrencesSince(cadence('0 0 * * *', 'UTC'), utc(2024, 6, 15, 10, 0), utc(2024, 6, 15, 10, 30))
    ).toEqual([])
  })

  it('counts exactly one occurrence on a fall-back day (fires once, not twice)', () => {
    // 2:30 AM daily across the whole 2024-11-03 fall-back day: only the 2:30 AM EST exists.
    const since = utc(2024, 11, 3, 0, 0)
    const now = utc(2024, 11, 3, 12, 0)
    expect(dueOccurrencesSince(cadence('30 2 * * *'), since, now)).toEqual([utc(2024, 11, 3, 7, 30)])
  })
})
