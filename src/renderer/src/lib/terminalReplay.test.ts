import { describe, expect, test } from 'vitest'
import { createReplayGate } from './terminalReplay'

describe('createReplayGate', () => {
  test('snapshot-only replay: returns just the buffer when nothing was queued', () => {
    const written: string[] = []
    const gate = createReplayGate((c) => written.push(c))

    const chunks = gate.completeSnapshot('SNAP', 0)

    expect(chunks).toEqual(['SNAP'])
    expect(written).toEqual([])
    expect(gate.isHydrated()).toBe(true)
  })

  test('queued chunks covered by the snapshot generation are dropped (no duplicate)', () => {
    const written: string[] = []
    const gate = createReplayGate((c) => written.push(c))

    // These arrived live but were already captured in the snapshot (their
    // generation <= snapshotGeneration), so replaying them would duplicate.
    gate.pushLive('covered-1', 1)
    gate.pushLive('covered-2', 2)

    expect(gate.completeSnapshot('SNAP', 2)).toEqual(['SNAP'])
    expect(written).toEqual([])
    expect(gate.isHydrated()).toBe(true)
  })

  test('queued chunks newer than the snapshot flush after the buffer in order', () => {
    const written: string[] = []
    const gate = createReplayGate((c) => written.push(c))

    // 1 and 2 are covered by the snapshot; 3 and 4 landed after it.
    gate.pushLive('a', 1)
    gate.pushLive('b', 2)
    gate.pushLive('c', 3)
    gate.pushLive('d', 4)

    expect(gate.completeSnapshot('SNAP', 2)).toEqual(['SNAP', 'c', 'd'])
    expect(written).toEqual([])
  })

  test('post-snapshot live chunks flow straight through onChunk', () => {
    const written: string[] = []
    const gate = createReplayGate((c) => written.push(c))

    gate.completeSnapshot('SNAP', 5)
    gate.pushLive('x', 6)
    gate.pushLive('y', 7)

    expect(written).toEqual(['x', 'y'])
  })

  test('completion is idempotent and cannot replay the snapshot twice', () => {
    const written: string[] = []
    const gate = createReplayGate((c) => written.push(c))

    gate.pushLive('a', 1)
    expect(gate.completeSnapshot('SNAP', 0)).toEqual(['SNAP', 'a'])
    // A second completion is a no-op.
    expect(gate.completeSnapshot('SNAP2', 0)).toEqual([])
    // Live output still flows through after the (ignored) second call.
    gate.pushLive('b', 2)
    expect(written).toEqual(['b'])
  })

  test('a snapshot failure or null snapshot flushes queued chunks via the no-fence path', () => {
    const written: string[] = []
    const gate = createReplayGate((c) => written.push(c))

    gate.pushLive('queued', 3)
    // No fence: empty buffer + snapshotGeneration 0 keeps every queued chunk
    // (all generations are > 0), so a missing snapshot never loses live output.
    const chunks = gate.completeSnapshot('', 0)
    expect(chunks).toEqual(['', 'queued'])
    expect(gate.isHydrated()).toBe(true)

    // Subsequent live chunks flow through immediately — no deadlock.
    gate.pushLive('after', 4)
    expect(written).toEqual(['after'])
  })
})
