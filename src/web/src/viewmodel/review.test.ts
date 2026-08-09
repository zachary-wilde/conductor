import { describe, expect, it } from 'vitest'
import type { DispatchVerification } from '@shared/types'
import { landRequiresConfirm, verificationStatus } from './review'

function verify(over: Partial<DispatchVerification> = {}): DispatchVerification {
  return { ok: true, output: '', ...over }
}

describe('verificationStatus', () => {
  it('maps a passing verification to passed', () => {
    expect(verificationStatus(verify({ ok: true, output: 'all green' }))).toBe('passed')
  })

  it('maps a failed verification to failed', () => {
    expect(verificationStatus(verify({ ok: false, output: 'exit 1' }))).toBe('failed')
  })

  it('maps a missing verification to unverified', () => {
    expect(verificationStatus(null)).toBe('unverified')
  })
})

describe('landRequiresConfirm', () => {
  it('is false when verification passed', () => {
    expect(landRequiresConfirm(verify({ ok: true }))).toBe(false)
  })

  it('is true when verification is null (never verified)', () => {
    expect(landRequiresConfirm(null)).toBe(true)
  })

  it('is true when verification failed', () => {
    expect(landRequiresConfirm(verify({ ok: false }))).toBe(true)
  })
})
