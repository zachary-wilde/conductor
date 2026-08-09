import { describe, expect, it } from 'vitest'
import type { AutomationDefinition } from '@ops/types'
import {
  automationApprove,
  automationSetEnabled,
  automationUpsert,
  isWorkerControl,
  reviewDecide,
  workerControl
} from './commands'

describe('workerControl', () => {
  it('builds an envelope with the provided operationId', () => {
    expect(workerControl('w1', 'pause', { operationId: 'op-1' })).toEqual({
      operationId: 'op-1',
      name: 'worker.control',
      payload: { workerId: 'w1', action: 'pause' }
    })
  })

  it('includes message only when provided', () => {
    const cmd = workerControl('w1', 'message', { operationId: 'op-1', message: 'hi' })
    expect(cmd.payload.message).toBe('hi')
    expect(cmd.payload.confirmed).toBeUndefined()
  })

  it('includes confirmed only when provided', () => {
    const cmd = workerControl('w1', 'stop', { operationId: 'op-1', confirmed: true })
    expect(cmd.payload.confirmed).toBe(true)
    expect(cmd.payload.message).toBeUndefined()
  })

  it('mints a uuid operationId by default', () => {
    expect(workerControl('w1', 'pause').operationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/)
  })
})

describe('reviewDecide', () => {
  const base = {
    repoId: 'r',
    branch: 'b',
    baseCommit: 'x',
    headCommit: 'y',
    diffDigest: 'd'
  }

  it('builds a land decision carrying confirmed', () => {
    expect(reviewDecide({ ...base, decision: 'land', confirmed: true, operationId: 'op-1' })).toEqual({
      operationId: 'op-1',
      name: 'review.decide',
      payload: { ...base, decision: 'land', confirmed: true }
    })
  })

  it('omits a blank note', () => {
    const cmd = reviewDecide({ ...base, decision: 'reject', note: '   ', operationId: 'op-1' })
    expect(cmd.payload.note).toBeUndefined()
  })

  it('keeps a non-empty note', () => {
    const cmd = reviewDecide({ ...base, decision: 'request-changes', note: 'fix x', operationId: 'op-1' })
    expect(cmd.payload.note).toBe('fix x')
  })
})

describe('automation commands', () => {
  it('setEnabled toggles the flag', () => {
    expect(automationSetEnabled('a1', false, 'op-1')).toEqual({
      operationId: 'op-1',
      name: 'automation.setEnabled',
      payload: { automationId: 'a1', enabled: false }
    })
  })

  it('approve binds to a revision id', () => {
    expect(automationApprove('a1', 'rev1', 'op-1')).toEqual({
      operationId: 'op-1',
      name: 'automation.approve',
      payload: { automationId: 'a1', revisionId: 'rev1' }
    })
  })

  it('upsert wraps the definition verbatim', () => {
    const def: AutomationDefinition = { id: 'a1', currentRevisionId: 'r1', revisions: [] }
    expect(automationUpsert(def, 'op-1')).toEqual({
      operationId: 'op-1',
      name: 'automation.upsert',
      payload: { definition: def }
    })
  })
})

describe('isWorkerControl', () => {
  it('narrows worker control commands only', () => {
    expect(isWorkerControl(workerControl('w', 'pause', { operationId: 'x' }))).toBe(true)
    expect(isWorkerControl(automationSetEnabled('a', true, 'x'))).toBe(false)
  })
})
