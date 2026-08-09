import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '@ops/events'
import { deriveWorkers, workerKey } from './workers'

function ev(over: Partial<NormalizedEvent> & Pick<NormalizedEvent, 'cursor'>): NormalizedEvent {
  return {
    id: `e${over.cursor}`,
    timestamp: over.cursor * 1000,
    repoId: null,
    rootWorkflowId: 'wf',
    rootWorkflowKind: 'session',
    parentWorkerId: null,
    workerId: null,
    workerKind: null,
    role: null,
    harness: null,
    model: null,
    attempt: 1,
    kind: 'lifecycle',
    summary: '',
    evidenceRefs: [],
    source: {},
    ...over
  }
}

describe('workerKey', () => {
  it('prefers workerId, then sessionId, then empty', () => {
    expect(workerKey(ev({ cursor: 1, workerId: 'w1' }))).toBe('w1')
    expect(workerKey(ev({ cursor: 1, source: { sessionId: 's1' } }))).toBe('s1')
    expect(workerKey(ev({ cursor: 1 }))).toBe('')
  })
})

describe('deriveWorkers', () => {
  it('dedupes by worker identity and counts events', () => {
    const workers = deriveWorkers([
      ev({ cursor: 1, workerId: 'w1', kind: 'lifecycle', summary: 'start' }),
      ev({ cursor: 2, workerId: 'w1', kind: 'tool', summary: 'ran tool' }),
      ev({ cursor: 3, workerId: 'w2', kind: 'conversation', summary: 'hi' })
    ])
    expect(workers).toHaveLength(2)
    const w1 = workers.find((w) => w.workerId === 'w1')
    expect(w1?.eventCount).toBe(2)
    expect(w1?.latestSummary).toBe('ran tool')
    expect(w1?.latestKind).toBe('tool')
  })

  it('falls back to sessionId when workerId is absent', () => {
    const workers = deriveWorkers([ev({ cursor: 1, source: { sessionId: 's1' } })])
    expect(workers[0].workerId).toBe('s1')
    expect(workers[0].sessionId).toBe('s1')
  })

  it('drops events with neither workerId nor sessionId', () => {
    expect(deriveWorkers([ev({ cursor: 1 })])).toEqual([])
  })

  it('sorts newest-first by lastSeen', () => {
    const workers = deriveWorkers([
      ev({ cursor: 1, workerId: 'old', timestamp: 100 }),
      ev({ cursor: 2, workerId: 'new', timestamp: 500 })
    ])
    expect(workers.map((w) => w.workerId)).toEqual(['new', 'old'])
  })
})
