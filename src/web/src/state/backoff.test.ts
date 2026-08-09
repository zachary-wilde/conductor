import { describe, expect, it } from 'vitest'
import {
  BACKOFF_CAP_MS,
  BACKOFF_SCHEDULE_MS,
  backoffDelay
} from './backoff'

describe('backoffDelay', () => {
  it('climbs the schedule attempt by attempt (no jitter)', () => {
    // random = 0.5 → jitter factor (0.5*2-1) = 0 → exactly the base delay.
    const mid = () => 0.5
    expect(backoffDelay(0, mid)).toBe(BACKOFF_SCHEDULE_MS[0])
    expect(backoffDelay(1, mid)).toBe(BACKOFF_SCHEDULE_MS[1])
    expect(backoffDelay(2, mid)).toBe(BACKOFF_SCHEDULE_MS[2])
  })

  it('caps at BACKOFF_CAP_MS past the end of the schedule', () => {
    const mid = () => 0.5
    expect(backoffDelay(BACKOFF_SCHEDULE_MS.length, mid)).toBe(BACKOFF_CAP_MS)
    expect(backoffDelay(50, mid)).toBe(BACKOFF_CAP_MS)
  })

  it('treats a negative / fractional attempt as 0', () => {
    const mid = () => 0.5
    expect(backoffDelay(-3, mid)).toBe(BACKOFF_SCHEDULE_MS[0])
    expect(backoffDelay(0.9, mid)).toBe(BACKOFF_SCHEDULE_MS[0])
  })

  it('applies ±jitter bounded by the base delay', () => {
    // random = 0 → jitter factor -1 → base * 0.9 (lower bound).
    expect(backoffDelay(0, () => 0)).toBe(Math.round(BACKOFF_SCHEDULE_MS[0] * 0.9))
    // random = 1 → jitter factor +1 → base * 1.1 (upper bound).
    expect(backoffDelay(0, () => 1)).toBe(Math.round(BACKOFF_SCHEDULE_MS[0] * 1.1))
  })

  it('jitter never pushes the delay below zero or above cap + jitter', () => {
    // Even at the cap with max negative jitter the result stays positive.
    expect(backoffDelay(9, () => 0)).toBeGreaterThan(0)
    // And max positive jitter at the cap is cap * 1.1.
    expect(backoffDelay(9, () => 1)).toBe(Math.round(BACKOFF_CAP_MS * 1.1))
  })

  it('is non-decreasing across attempts at the midpoint', () => {
    const mid = () => 0.5
    let prev = -1
    for (let a = 0; a < 8; a++) {
      const d = backoffDelay(a, mid)
      expect(d).toBeGreaterThanOrEqual(prev)
      prev = d
    }
  })
})
