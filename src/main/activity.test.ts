import { afterEach, describe, expect, test } from 'vitest'
import type { Session } from '@shared/types'
import { activityWatchArmed, startActivityWatch, stopActivityWatch, syncActivityWatch } from './activity'

/**
 * The idle-cost guarantee, made testable.
 *
 * The watcher used to take an unconditional 1.5s interval at launch and filter the
 * session list inside the tick, so an idle app woke 40x/minute doing nothing. These
 * tests assert on the timer's EXISTENCE, not on its work — that is the actual claim.
 */
function session(id: string, status: Session['status']): Session {
  return {
    id,
    repoId: 'repo',
    repoPath: 'D:/repo',
    worktreePath: 'D:/repo',
    branch: 'main',
    harness: 'claude',
    status,
    title: null,
    initialPrompt: null,
    createdAt: 0,
    lastActivityAt: 0,
    kind: 'normal',
    parentId: null,
    ravelId: null,
    ravelRole: null,
    briefId: null
  }
}

afterEach(() => {
  stopActivityWatch()
})

describe('activity watch arming', () => {
  test('registering the watch on an empty fleet schedules nothing', () => {
    startActivityWatch(() => [], () => {})
    expect(activityWatchArmed()).toBe(false)
  })

  test('arms on the first live session and disarms after the last one ends', () => {
    let sessions: Session[] = []
    startActivityWatch(() => sessions, () => {})
    expect(activityWatchArmed()).toBe(false)

    sessions = [session('a', 'running')]
    syncActivityWatch()
    expect(activityWatchArmed()).toBe(true)

    sessions = []
    syncActivityWatch()
    expect(activityWatchArmed()).toBe(false)
  })

  test('closed sessions and sessions without a worktree never arm the poll', () => {
    startActivityWatch(() => [session('a', 'closed')], () => {})
    expect(activityWatchArmed()).toBe(false)

    const detached = { ...session('b', 'running'), worktreePath: '' }
    startActivityWatch(() => [detached], () => {})
    expect(activityWatchArmed()).toBe(false)
  })

  test('syncing repeatedly while live does not stack intervals', () => {
    const live = [session('a', 'running')]
    startActivityWatch(() => live, () => {})
    syncActivityWatch()
    syncActivityWatch()
    expect(activityWatchArmed()).toBe(true)
    stopActivityWatch()
    expect(activityWatchArmed()).toBe(false)
  })

  test('a sync after stop cannot resurrect the poll', () => {
    startActivityWatch(() => [session('a', 'running')], () => {})
    stopActivityWatch()
    syncActivityWatch()
    expect(activityWatchArmed()).toBe(false)
  })
})
