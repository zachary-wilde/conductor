import { describe, expect, test } from 'vitest'
import { acrylicTint } from './acrylic'
import { ACRYLIC_INTENSITY_MAX, ACRYLIC_INTENSITY_MIN, DEFAULT_SETTINGS } from '@shared/types'

/**
 * The intensity slider used to be a lie: it only restyled renderer CSS and never
 * reached the Win10 composition tint. These lock the mapping it now drives.
 */
describe('acrylic tint mapping', () => {
  test('the shipped default reproduces the hand-tuned 0x4a tint', () => {
    // 71% glass = 29% opaque = Windows Terminal's `"opacity": 29`, which is the
    // value the effect was tuned against.
    expect(DEFAULT_SETTINGS.acrylicIntensity).toBe(71)
    expect(acrylicTint(DEFAULT_SETTINGS.acrylicIntensity)).toBe(0x4a101014)
  })

  test('maximum glass removes the tint entirely and minimum makes it opaque', () => {
    expect(acrylicTint(ACRYLIC_INTENSITY_MAX)).toBe(0x00101014)
    expect(acrylicTint(ACRYLIC_INTENSITY_MIN)).toBe(0xff101014)
  })

  test('more intensity is always less alpha', () => {
    let previous = acrylicTint(0) >>> 24
    for (let intensity = 5; intensity <= 100; intensity += 5) {
      const alpha = acrylicTint(intensity) >>> 24
      expect(alpha).toBeLessThan(previous)
      previous = alpha
    }
  })

  test('every value stays an unsigned 32-bit colour koffi will accept', () => {
    // alpha >= 0x80 shifted into bit 31 yields a negative number without the
    // unsigned coercion, which the FFI rejects at the exact settings a user
    // picks when they want a nearly solid window.
    for (const intensity of [0, 10, 40, 49, 50, 71, 100]) {
      const tint = acrylicTint(intensity)
      expect(tint).toBeGreaterThanOrEqual(0)
      expect(tint).toBeLessThanOrEqual(0xffffffff)
      expect(Number.isInteger(tint)).toBe(true)
    }
  })

  test('a nonsense intensity falls back to the default rather than a black window', () => {
    expect(acrylicTint(Number.NaN)).toBe(acrylicTint(71))
    expect(acrylicTint(-40)).toBe(acrylicTint(ACRYLIC_INTENSITY_MIN))
    expect(acrylicTint(400)).toBe(acrylicTint(ACRYLIC_INTENSITY_MAX))
  })
})
