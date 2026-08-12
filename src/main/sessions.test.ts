import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest'

// --- Fakes ----------------------------------------------------------------

/**
 * A controllable fake PTY. The test emits chunks through `emit()` which
 * dispatches to the `onData` callback registered by sessions.ts, exactly as a
 * real node-pty would. `cols`/`rows` are live getters so resize + snapshot
 * reflect the current dimensions.
 */
const mockPty = vi.hoisted(() => {
  let dataCb: (chunk: string) => void = () => {}
  let exitCb: (e: { exitCode: number }) => void = () => {}
  const dims = { cols: 100, rows: 28 }
  return {
    dims,
    reset(): void {
      dataCb = () => {}
      exitCb = () => {}
      dims.cols = 100
      dims.rows = 28
    },
    emit(chunk: string): void {
      dataCb(chunk)
    },
    exit(code: number): void {
      exitCb({ exitCode: code })
    },
    spawn() {
      return {
        onData: (cb: (chunk: string) => void): void => {
          dataCb = cb
        },
        onExit: (cb: (e: { exitCode: number }) => void): void => {
          exitCb = cb
        },
        write: (): void => {},
        resize: (c: number, r: number): void => {
          dims.cols = c
          dims.rows = r
        },
        kill: (): void => {},
        pid: 12345,
        get cols(): number {
          return dims.cols
        },
        get rows(): number {
          return dims.rows
        }
      }
    }
  }
})

vi.mock('node-pty', () => ({ spawn: mockPty.spawn }))
vi.mock('./harness', () => ({
  resolveShell: async () => ({ id: null, command: 'fake-shell', args: [], resolvedFrom: 'fake-shell' }),
  resolveHarness: async () => {
    throw new Error('not used')
  },
  buildLaunchArgs: () => [],
  harnessEnv: () => ({ env: {}, stripped: [] })
}))
vi.mock('./proc', () => ({ killProcessTree: () => {} }))

// --- Module under test ----------------------------------------------------

import { createSession, snapshotSession, killSession, resizeSession, setSessionEvents } from './sessions'
import type { CreateSessionRequest, Settings } from '@shared/types'

/** Mirrors the private bound in sessions.ts; the test only checks behaviour. */
const REPLAY_BOUND = 128 * 1024

async function makeSession(): Promise<string> {
  const req: CreateSessionRequest = {
    kind: 'normal',
    harness: null,
    repoId: 'r',
    repoPath: '/r',
    worktreePath: '/r',
    branch: 'main'
  }
  const session = await createSession(req, {} as Settings)
  return session.id
}

describe('snapshotSession', () => {
  let ids: string[] = []

  beforeEach(() => {
    mockPty.reset()
    ids = []
  })

  afterEach(() => {
    for (const id of ids) killSession(id)
  })

  test('returns null for an unknown session id', () => {
    expect(snapshotSession('does-not-exist')).toBeNull()
  })

  test('returns raw ANSI text and current dimensions for a known session', async () => {
    const id = await makeSession()
    ids.push(id)
    const ansi = '\u001b[32mgreen text\u001b[0m\r\n'
    mockPty.emit(ansi)
    const snap = snapshotSession(id)
    expect(snap).not.toBeNull()
    expect(snap!.sessionId).toBe(id)
    expect(snap!.buffer).toBe(ansi)
    expect(snap!.generation).toBe(1)
    expect(snap!.cols).toBe(100)
    expect(snap!.rows).toBe(28)
    expect(snap!.truncated).toBe(false)
  })

  test('generation increases as chunks arrive', async () => {
    const id = await makeSession()
    ids.push(id)
    mockPty.emit('a')
    mockPty.emit('b')
    mockPty.emit('c')
    const snap = snapshotSession(id)
    expect(snap!.generation).toBe(3)
    expect(snap!.buffer).toBe('abc')
  })

  test('reflects the current cols/rows after a resize', async () => {
    const id = await makeSession()
    ids.push(id)
    resizeSession(id, 120, 40)
    const snap = snapshotSession(id)
    expect(snap!.cols).toBe(120)
    expect(snap!.rows).toBe(40)
  })

  test('buffer retains the newest data after exceeding the bound and reports truncated', async () => {
    const id = await makeSession()
    ids.push(id)
    // Write more than the bound, then a distinctive tail that must survive.
    mockPty.emit('x'.repeat(REPLAY_BOUND + 10_000))
    const tail = '-NEWEST'
    mockPty.emit(tail)
    const snap = snapshotSession(id)
    expect(snap!.truncated).toBe(true)
    expect(snap!.buffer.length).toBeLessThanOrEqual(REPLAY_BOUND + tail.length)
    expect(snap!.buffer.endsWith(tail)).toBe(true)
    expect(snap!.generation).toBe(2)
  })

  test('live data event still receives each raw chunk unchanged with its generation', async () => {
    const id = await makeSession()
    ids.push(id)
    const received: Array<{ data: string; generation: number }> = []
    setSessionEvents({
      data: (sid, data, generation) => {
        if (sid === id) received.push({ data, generation })
      },
      created: () => {},
      exit: () => {},
      status: () => {},
      progress: () => {}
    })
    const chunks = ['hello\r\n', '\u001b[1mbold\u001b[0m', 'world']
    for (const c of chunks) mockPty.emit(c)
    expect(received.map((r) => r.data)).toEqual(chunks)
    // Generation is monotonic per chunk and matches the snapshot's chunk count.
    expect(received.map((r) => r.generation)).toEqual([1, 2, 3])
    expect(snapshotSession(id)?.generation).toBe(3)
    // Restore no-op events so other test files are unaffected.
    setSessionEvents({
      data: () => {},
      created: () => {},
      exit: () => {},
      status: () => {},
      progress: () => {}
    })
  })
})
