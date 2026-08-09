import { describe, expect, it } from 'vitest'
import { DETACH_EFFECT, detachConfirmCopy } from './detachConfirm'

describe('detachConfirmCopy', () => {
  it('flags dependents and pluralizes the count when titles are present', () => {
    const copy = detachConfirmCopy(['Ship the API', 'Write the docs'])
    expect(copy.hasDependents).toBe(true)
    expect(copy.intro).toBe('Detaching this worker blocks 2 dependent briefs:')
    expect(copy.dependentBriefs).toEqual(['Ship the API', 'Write the docs'])
  })

  it('uses the singular "dependent brief" for a single dependent', () => {
    const copy = detachConfirmCopy(['Only one'])
    expect(copy.intro).toBe('Detaching this worker blocks 1 dependent brief:')
    expect(copy.dependentBriefs).toEqual(['Only one'])
  })

  it('falls back to the light standalone-session prompt with no dependents', () => {
    const copy = detachConfirmCopy([])
    expect(copy.hasDependents).toBe(false)
    expect(copy.dependentBriefs).toEqual([])
    expect(copy.intro).toBe(
      'Detach hands this running agent to you as a standalone session and asks the Ravel to replan.'
    )
  })

  it('drops blank titles so the confirmation never names an empty slot', () => {
    const copy = detachConfirmCopy(['Real brief', '   ', ''])
    expect(copy.hasDependents).toBe(true)
    expect(copy.dependentBriefs).toEqual(['Real brief'])
    expect(copy.intro).toBe('Detaching this worker blocks 1 dependent brief:')
  })

  it('always states the same detach effect, with or without dependents', () => {
    const a = detachConfirmCopy([])
    const b = detachConfirmCopy(['x', 'y'])
    expect(a.effect).toBe(b.effect)
    expect(a.effect).toBe(DETACH_EFFECT)
    expect(a.effect).toMatch(/nothing is killed/)
  })
})
