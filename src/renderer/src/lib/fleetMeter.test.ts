import { describe, expect, test } from 'vitest'
import type { PublicRavelConfig, RavelStatus, Session } from '@shared/types'
import { formatCost, formatTokens, ravelSpend, selectFleetMeter } from './fleetMeter'
import { ravelFixture } from './testStubs'

function session(id: string, status: Session['status']): Session {
  return {
    id,
    repoId: 'repo-1',
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

function ravel(
  id: string,
  status: RavelStatus,
  spent: number,
  extra: Partial<PublicRavelConfig> = {}
): PublicRavelConfig {
  return ravelFixture({
    id,
    status,
    usage: { inputTokens: 0, outputTokens: spent, costUsd: null },
    ...extra
  })
}

describe('fleet meter focus', () => {
  test('an empty fleet reads idle rather than zero-of-something', () => {
    const meter = selectFleetMeter([], [], 100_000)
    expect(meter.level).toBe('idle')
    expect(meter.ravel).toBeNull()
    expect(meter.ratio).toBeNull()
    expect(meter.action).toBe('none')
  })

  /**
   * The rule spend alone gets wrong. A finished ravel that burned 200k would own
   * the ring forever while the running one about to breach stayed invisible —
   * exactly the ravel the meter exists to show.
   */
  test('a running ravel outranks a finished one that spent far more', () => {
    const finished = ravel('finished', 'completed', 200_000, { createdAt: 5000 })
    const live = ravel('live', 'running', 49_000, { createdAt: 1000 })
    expect(selectFleetMeter([finished, live], [], 50_000).ravel?.id).toBe('live')
    expect(selectFleetMeter([live, finished], [], 50_000).ravel?.id).toBe('live')
  })

  test('ranks running over awaiting-approval over paused over terminal', () => {
    const pool = [
      ravel('completed', 'completed', 900),
      ravel('paused', 'paused', 900),
      ravel('awaiting', 'awaiting-approval', 900),
      ravel('running', 'running', 900)
    ]
    const winner = (exclude: string[]): string | undefined =>
      selectFleetMeter(pool.filter((r) => !exclude.includes(r.id)), [], 0).ravel?.id
    expect(winner([])).toBe('running')
    expect(winner(['running'])).toBe('awaiting')
    expect(winner(['running', 'awaiting'])).toBe('paused')
    expect(winner(['running', 'awaiting', 'paused'])).toBe('completed')
  })

  test('within one status the biggest spender wins, then the newest', () => {
    const small = ravel('small', 'running', 10, { createdAt: 9000 })
    const big = ravel('big', 'running', 10_000, { createdAt: 1000 })
    expect(selectFleetMeter([small, big], [], 0).ravel?.id).toBe('big')

    const older = ravel('older', 'running', 500, { createdAt: 1000 })
    const newer = ravel('newer', 'running', 500, { createdAt: 2000 })
    expect(selectFleetMeter([older, newer], [], 0).ravel?.id).toBe('newer')
    expect(selectFleetMeter([newer, older], [], 0).ravel?.id).toBe('newer')
  })
})

describe('fleet meter level', () => {
  test('no ceiling means no ratio — an unbounded ring would be a lie', () => {
    const meter = selectFleetMeter([ravel('a', 'running', 1000)], [], 0)
    expect(meter.ratio).toBeNull()
    expect(meter.level).toBe('ok')
    expect(meter.spent).toBe(1000)
  })

  test('crosses to warn at three quarters and to breach at the ceiling', () => {
    const at = (spent: number): string =>
      selectFleetMeter([ravel('a', 'running', spent)], [], 1000).level
    expect(at(740)).toBe('ok')
    expect(at(750)).toBe('warn')
    expect(at(999)).toBe('warn')
    expect(at(1000)).toBe('breach')
    expect(at(4000)).toBe('breach')
  })

  test('the arc clamps at full even when spend overshoots the ceiling', () => {
    const meter = selectFleetMeter([ravel('a', 'running', 9000)], [], 1000)
    expect(meter.ratio).toBe(1)
    expect(meter.spent).toBe(9000)
  })

  test('a paused ravel under its ceiling is not a breach', () => {
    expect(selectFleetMeter([ravel('a', 'paused', 500)], [], 1000).level).toBe('ok')
  })
})

describe('fleet meter action', () => {
  test('offers Pause only where children can still be spending', () => {
    const action = (status: RavelStatus): string =>
      selectFleetMeter([ravel('a', status, 10)], [], 0).action
    expect(action('running')).toBe('pause')
    expect(action('awaiting-approval')).toBe('pause')
    expect(action('idle')).toBe('none')
    expect(action('error')).toBe('none')
    expect(action('completed')).toBe('none')
  })

  /**
   * Resuming a ravel still at its ceiling re-pauses it at the next budget gate,
   * so the control has to send you to the ceiling first instead of pretending.
   */
  test('resume is blocked while the paused ravel sits at its ceiling', () => {
    expect(selectFleetMeter([ravel('a', 'paused', 400)], [], 1000).action).toBe('resume')
    expect(selectFleetMeter([ravel('a', 'paused', 1000)], [], 1000).action).toBe('resume-blocked')
    expect(selectFleetMeter([ravel('a', 'paused', 9000)], [], 1000).action).toBe('resume-blocked')
    // No ceiling means nothing to raise.
    expect(selectFleetMeter([ravel('a', 'paused', 9000)], [], 0).action).toBe('resume')
  })
})

describe('fleet meter counts', () => {
  test('counts only sessions that still hold a pty', () => {
    const sessions = [
      session('a', 'starting'),
      session('b', 'running'),
      session('c', 'needs-input'),
      session('d', 'closed'),
      // A non-zero exit sets 'error' and drops the runtime; the renderer's copy
      // lingers, and counting it would report a dead session as live.
      session('e', 'error')
    ]
    expect(selectFleetMeter([], sessions, 0).liveSessionCount).toBe(3)
  })

  test('reports the whole fleet size, not just the focus ravel', () => {
    const pool = [ravel('a', 'running', 1), ravel('b', 'idle', 2), ravel('c', 'completed', 3)]
    expect(selectFleetMeter(pool, [], 0).ravelCount).toBe(3)
  })
})

describe('token formatting', () => {
  test('keeps small counts exact and abbreviates the rest', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(12_400)).toBe('12.4k')
    expect(formatTokens(99_500)).toBe('99.5k')
    expect(formatTokens(2_400_000)).toBe('2.4M')
  })

  test('drops a trailing .0 so the ceiling chips read as round numbers', () => {
    expect(formatTokens(1000)).toBe('1k')
    expect(formatTokens(50_000)).toBe('50k')
    expect(formatTokens(100_000)).toBe('100k')
    expect(formatTokens(250_000)).toBe('250k')
  })

  test('rolls into M rather than printing a 1000k that appears nowhere else', () => {
    expect(formatTokens(999_400)).toBe('999k')
    expect(formatTokens(999_500)).toBe('1M')
    expect(formatTokens(1_000_000)).toBe('1M')
  })
})

describe('cost formatting', () => {
  test('an unpriced model says so instead of vanishing', () => {
    expect(formatCost(null)).toBe('cost unknown')
  })

  test('a real sub-cent charge never renders as $0.00', () => {
    expect(formatCost(0.004)).toBe('<$0.01')
    expect(formatCost(0)).toBe('~$0.00')
    expect(formatCost(0.42)).toBe('~$0.42')
    expect(formatCost(12.5)).toBe('~$12.50')
  })
})

describe('ravel spend', () => {
  test('is both halves of the estimate, not just output', () => {
    expect(
      ravelSpend(ravelFixture({ usage: { inputTokens: 300, outputTokens: 700, costUsd: null } }))
    ).toBe(1000)
  })
})
