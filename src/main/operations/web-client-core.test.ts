import { describe, expect, it } from 'vitest'
import {
  applyFrame,
  clearResync,
  commandRequest,
  eventsPath,
  initialTimeline,
  isCompatible,
  parseHandshake,
  queryRequest
} from './web-client-core'
import type { TimelineState } from './web-client-core'
import type {
  ClientCommand,
  ClientQuery,
  CoreHandshake,
  EventStreamFrame
} from './api-contract'
import type { EventCursor, NormalizedEvent } from './events'

/**
 * Build a normalized event fixed at `cursor`, any field overridable. Cursors are
 * the only ordering axis the reducer cares about, so every other field is a
 * stable default; `timestamp` derives from the cursor so fixtures never touch
 * the wall clock.
 */
const ev = (cursor: EventCursor, over: Partial<NormalizedEvent> = {}): NormalizedEvent => ({
  id: `evt-${cursor}`,
  cursor,
  timestamp: 1_000_000 + cursor,
  repoId: null,
  rootWorkflowId: 'wf-1',
  rootWorkflowKind: 'session',
  parentWorkerId: null,
  workerId: 'w-1',
  workerKind: 'session',
  role: null,
  harness: null,
  model: null,
  attempt: 1,
  kind: 'lifecycle',
  summary: `event ${cursor}`,
  evidenceRefs: [],
  source: {},
  ...over
})

/** A handshake with version fields the local build considers compatible. */
const hs = (over: Partial<CoreHandshake> = {}): CoreHandshake => ({
  coreVersion: '1.0.0',
  apiVersion: 1,
  storeSchemaVersion: 3,
  capabilities: ['timeline', 'automation'],
  cursor: 7,
  ...over
})

/** The local build's version pair, matching the default `hs()`. */
const LOCAL = { apiVersion: 1, storeSchemaVersion: 3 } as const

describe('commandRequest', () => {
  it('produces a POST to /api/command with a round-trippable JSON body', () => {
    const cmd: ClientCommand = {
      operationId: 'op-1',
      name: 'worker.control',
      payload: { workerId: 'w-1', action: 'pause' }
    }
    const req = commandRequest(cmd)
    expect(req.method).toBe('POST')
    expect(req.path).toBe('/api/command')
    expect(typeof req.body).toBe('string')
    expect(JSON.parse(req.body)).toEqual(cmd)
  })

  it('preserves the operationId on round-trip', () => {
    const cmd: ClientCommand = {
      operationId: 'op-2',
      name: 'automation.setEnabled',
      payload: { automationId: 'a-1', enabled: false }
    }
    const { body } = commandRequest(cmd)
    expect(JSON.parse(body)).toEqual(cmd)
  })
})

describe('queryRequest', () => {
  it('produces a POST to /api/query with a round-trippable JSON body', () => {
    const q: ClientQuery = { name: 'timeline.read', afterCursor: 5, limit: 10 }
    const req = queryRequest(q)
    expect(req.method).toBe('POST')
    expect(req.path).toBe('/api/query')
    expect(typeof req.body).toBe('string')
    expect(JSON.parse(req.body)).toEqual(q)
  })

  it('round-trips a parameterless query', () => {
    const q: ClientQuery = { name: 'automation.list' }
    expect(JSON.parse(queryRequest(q).body)).toEqual(q)
  })
})

describe('eventsPath', () => {
  it('encodes the cursor into the events stream path', () => {
    expect(eventsPath(0)).toBe('/api/events?after=0')
    expect(eventsPath(42)).toBe('/api/events?after=42')
  })
})

describe('parseHandshake', () => {
  it('round-trips a well-formed handshake', () => {
    const raw = {
      coreVersion: '1.0.0',
      apiVersion: 1,
      storeSchemaVersion: 3,
      capabilities: ['a', 'b'],
      cursor: 7
    }
    expect(parseHandshake(raw)).toEqual(raw)
  })

  it('rejects a non-object', () => {
    expect(() => parseHandshake('nope')).toThrow()
    expect(() => parseHandshake(null)).toThrow()
    expect(() => parseHandshake(undefined)).toThrow()
  })

  it('rejects a wrong-typed field', () => {
    const good = hs()
    expect(() => parseHandshake({ ...good, coreVersion: 1 })).toThrow()
    expect(() => parseHandshake({ ...good, apiVersion: '1' })).toThrow()
    expect(() => parseHandshake({ ...good, storeSchemaVersion: true })).toThrow()
    expect(() => parseHandshake({ ...good, cursor: NaN })).toThrow()
    expect(() => parseHandshake({ ...good, capabilities: ['ok', 5] })).toThrow()
  })
})

describe('isCompatible', () => {
  it('is true on an exact double-version match', () => {
    expect(isCompatible(LOCAL, hs())).toBe(true)
  })

  it('is false when only apiVersion differs', () => {
    expect(isCompatible(LOCAL, hs({ apiVersion: 2 }))).toBe(false)
  })

  it('is false when only storeSchemaVersion differs', () => {
    expect(isCompatible(LOCAL, hs({ storeSchemaVersion: 4 }))).toBe(false)
  })

  it('is false when both differ', () => {
    expect(isCompatible(LOCAL, hs({ apiVersion: 2, storeSchemaVersion: 4 }))).toBe(false)
  })

  it('is false when the core is older on either axis', () => {
    expect(isCompatible(LOCAL, hs({ apiVersion: 0 }))).toBe(false)
    expect(isCompatible(LOCAL, hs({ storeSchemaVersion: 2 }))).toBe(false)
  })
})

describe('timeline reducer', () => {
  describe('initialTimeline', () => {
    it('starts empty at cursor 0 with no resync', () => {
      expect(initialTimeline()).toEqual({
        events: [],
        cursor: 0,
        needsResyncFrom: null
      })
    })
  })

  describe('applyFrame (event)', () => {
    it('appends events in order and advances the cursor', () => {
      let s = initialTimeline()
      s = applyFrame(s, { type: 'event', event: ev(1) })
      s = applyFrame(s, { type: 'event', event: ev(2) })
      s = applyFrame(s, { type: 'event', event: ev(3) })

      expect(s.events.map((e) => e.cursor)).toEqual([1, 2, 3])
      expect(s.cursor).toBe(3)
      expect(s.needsResyncFrom).toBeNull()
    })

    it('ignores a duplicate-cursor event frame', () => {
      let s = initialTimeline()
      s = applyFrame(s, { type: 'event', event: ev(2) })

      const after = applyFrame(s, { type: 'event', event: ev(2) })
      expect(after.events.map((e) => e.cursor)).toEqual([2])
      expect(after.cursor).toBe(2)
    })

    it('ignores an older-cursor event frame', () => {
      let s = initialTimeline()
      s = applyFrame(s, { type: 'event', event: ev(5) })

      const after = applyFrame(s, { type: 'event', event: ev(3) })
      expect(after.events.map((e) => e.cursor)).toEqual([5])
      expect(after.cursor).toBe(5)
    })

    it('ignores cursor 0 against an initial (cursor 0) state', () => {
      // cursor <= state.cursor (0 <= 0): treated as a duplicate of nothing.
      const after = applyFrame(initialTimeline(), { type: 'event', event: ev(0) })
      expect(after.events).toHaveLength(0)
      expect(after.cursor).toBe(0)
    })

    it('trims to the most-recent N when max is set', () => {
      let s = initialTimeline()
      for (const c of [1, 2, 3, 4, 5]) {
        s = applyFrame(s, { type: 'event', event: ev(c) }, { max: 3 })
      }
      expect(s.events.map((e) => e.cursor)).toEqual([3, 4, 5])
      expect(s.cursor).toBe(5)
    })

    it('does not trim when max is unset (unbounded)', () => {
      let s = initialTimeline()
      for (const c of [1, 2, 3, 4, 5]) {
        s = applyFrame(s, { type: 'event', event: ev(c) })
      }
      expect(s.events).toHaveLength(5)
    })
  })

  describe('applyFrame (gap)', () => {
    it('sets needsResyncFrom without touching events or cursor', () => {
      let s = initialTimeline()
      s = applyFrame(s, { type: 'event', event: ev(1) })
      s = applyFrame(s, { type: 'event', event: ev(2) })

      const after = applyFrame(s, { type: 'gap', earliestAvailable: 100 })
      expect(after.events.map((e) => e.cursor)).toEqual([1, 2])
      expect(after.cursor).toBe(2)
      expect(after.needsResyncFrom).toBe(100)
    })

    it('overwrites a prior resync cursor with the latest gap', () => {
      let s = initialTimeline()
      s = applyFrame(s, { type: 'gap', earliestAvailable: 50 })
      s = applyFrame(s, { type: 'gap', earliestAvailable: 80 })
      expect(s.needsResyncFrom).toBe(80)
    })
  })

  describe('clearResync', () => {
    it('resets the resync flag while keeping events and cursor', () => {
      let s = initialTimeline()
      s = applyFrame(s, { type: 'event', event: ev(1) })
      s = applyFrame(s, { type: 'gap', earliestAvailable: 50 })
      expect(s.needsResyncFrom).toBe(50)

      const cleared = clearResync(s)
      expect(cleared.needsResyncFrom).toBeNull()
      expect(cleared.cursor).toBe(1)
      expect(cleared.events.map((e) => e.cursor)).toEqual([1])
    })

    it('is a no-op when no resync is pending', () => {
      let s = initialTimeline()
      s = applyFrame(s, { type: 'event', event: ev(4) })
      const cleared = clearResync(s)
      expect(cleared.needsResyncFrom).toBeNull()
      expect(cleared.cursor).toBe(4)
    })
  })

  describe('immutability', () => {
    it('applyFrame never mutates the input state (event append)', () => {
      let s = initialTimeline()
      s = applyFrame(s, { type: 'event', event: ev(1) })

      const snapshot = {
        events: s.events.map((e) => ({ ...e })),
        cursor: s.cursor,
        needsResyncFrom: s.needsResyncFrom
      }
      const originalArray = s.events

      applyFrame(s, { type: 'event', event: ev(2) })
      applyFrame(s, { type: 'gap', earliestAvailable: 9 })

      // Same array reference, unmodified contents, unchanged scalars.
      expect(s.events).toBe(originalArray)
      expect(s.events.map((e) => ({ ...e }))).toEqual(snapshot.events)
      expect(s.cursor).toBe(snapshot.cursor)
      expect(s.needsResyncFrom).toBe(snapshot.needsResyncFrom)
    })

    it('applyFrame never mutates the input state (duplicate ignore)', () => {
      let s = initialTimeline()
      s = applyFrame(s, { type: 'event', event: ev(3) })
      const snapshot = { len: s.events.length, cursor: s.cursor }
      const originalArray = s.events

      applyFrame(s, { type: 'event', event: ev(3) })
      expect(s.events).toBe(originalArray)
      expect(s.events).toHaveLength(snapshot.len)
      expect(s.cursor).toBe(snapshot.cursor)
    })

    it('the returned state is a distinct object from the input', () => {
      const s = applyFrame(initialTimeline(), { type: 'event', event: ev(1) })
      const out = applyFrame(s, { type: 'event', event: ev(2) })
      expect(out).not.toBe(s)
      expect(out.events).not.toBe(s.events)
    })
  })

  describe('integration', () => {
    it('reduces a mixed stream of events and a gap into consistent state', () => {
      const frames: EventStreamFrame[] = [
        { type: 'event', event: ev(1) },
        { type: 'event', event: ev(2) },
        { type: 'event', event: ev(2) }, // duplicate replay
        { type: 'gap', earliestAvailable: 10 },
        { type: 'event', event: ev(3) } // post-gap live event still appends
      ]
      const final = frames.reduce<TimelineState>(
        (st, f) => applyFrame(st, f),
        initialTimeline()
      )
      expect(final.events.map((e) => e.cursor)).toEqual([1, 2, 3])
      expect(final.cursor).toBe(3)
      expect(final.needsResyncFrom).toBe(10)

      const cleared = clearResync(final)
      expect(cleared.needsResyncFrom).toBeNull()
      expect(cleared.events.map((e) => e.cursor)).toEqual([1, 2, 3])
    })
  })
})
