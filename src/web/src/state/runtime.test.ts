import { describe, expect, it } from 'vitest'
import { runtimeStatusLabel, type RuntimeStatus } from './runtime'

describe('Runtime panel status', () => {
  it('labels an unavailable tablet runtime without implying it is live', () => {
    const status: RuntimeStatus = { state: 'unavailable' }

    expect(runtimeStatusLabel(status)).toEqual({
      title: 'Unavailable',
      tone: 'danger',
      detail: 'Runtime service is not reachable on this tablet.'
    })
  })

  it('labels a connected runtime with its Core state', () => {
    const status: RuntimeStatus = { state: 'connected', coreState: 'ready' }

    expect(runtimeStatusLabel(status)).toEqual({
      title: 'Connected',
      tone: 'success',
      detail: 'Core ready'
    })
  })
})
