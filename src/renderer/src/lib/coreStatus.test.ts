import { describe, expect, test } from 'vitest'
import { coreStatusBanner, coreStatusLogPath } from './coreStatus'

describe('coreStatusBanner', () => {
  test('connecting → subtle connecting tone', () => {
    expect(coreStatusBanner({ state: 'connecting' })).toEqual({
      tone: 'connecting',
      message: 'Connecting to Conductor Core…'
    })
  })

  test('error → prominent error tone (manager keeps retrying)', () => {
    expect(coreStatusBanner({ state: 'error', detail: 'ECONNREFUSED' })).toEqual({
      tone: 'error',
      message: 'Conductor Core unavailable — retrying…'
    })
  })

  test('connected → no banner at all', () => {
    expect(coreStatusBanner({ state: 'connected' })).toBeNull()
  })

  test('copy is independent of detail (the view renders detail separately)', () => {
    expect(coreStatusBanner({ state: 'connecting', detail: 'spawn' })).toEqual(
      coreStatusBanner({ state: 'connecting' })
    )
    expect(coreStatusBanner({ state: 'error', detail: 'a' })).toEqual(
      coreStatusBanner({ state: 'error', detail: 'b' })
    )
  })
})

describe('coreStatusLogPath', () => {
  test('extracts the diagnostic path from error detail', () => {
    expect(coreStatusLogPath('Core log: D:/core.log\nCore exit code: 1')).toBe('D:/core.log')
    expect(coreStatusLogPath(undefined)).toBeNull()
  })
})
