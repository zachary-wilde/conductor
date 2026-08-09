import { describe, expect, it } from 'vitest'
import { revisionToLaunch } from './automation-launch'
import type { AutomationRevision, CronSpec } from './types'

const EVERY_MINUTE: CronSpec = { expression: '* * * * *', timezone: 'UTC' }

/** Build an immutable revision; sensible defaults, any field overridable. */
const revision = (over: Partial<AutomationRevision> = {}): AutomationRevision => ({
  id: 'rev-1',
  kind: 'schedule',
  title: 'Nightly build',
  enabled: true,
  cadence: EVERY_MINUTE,
  targetId: null,
  prompt: 'run the suite',
  repoId: 'repo-1',
  harness: null,
  model: null,
  ravelRoster: [],
  verificationCommand: null,
  perRunTokenCeiling: null,
  concurrency: 'single-flight',
  stopCondition: { kind: 'until-disabled' },
  approval: { createdBy: 'operator', createdAt: 0, approvedAt: 0 },
  ...over
})

const ctx = { repoPath: 'D:/repo', defaultHarness: 'claude' as const }

describe('revisionToLaunch', () => {
  describe('spawn-ravel', () => {
    it('maps a schedule revision to a spawn-ravel action with every field', () => {
      const action = revisionToLaunch(
        revision({
          kind: 'schedule',
          title: 'Nightly build',
          repoId: 'repo-42',
          harness: 'codex',
          model: 'o3',
          prompt: 'run the suite'
        }),
        ctx
      )

      expect(action).toEqual({
        kind: 'spawn-ravel',
        request: {
          name: 'Nightly build',
          repoId: 'repo-42',
          repoPath: 'D:/repo',
          harness: 'codex',
          model: 'o3',
          initialInstruction: 'run the suite',
          allowRisky: false
        }
      })
    })

    it('falls back to defaultHarness when revision.harness is null', () => {
      const action = revisionToLaunch(
        revision({ kind: 'schedule', harness: null }),
        { repoPath: 'D:/repo', defaultHarness: 'zai' }
      )
      expect(action.kind).toBe('spawn-ravel')
      if (action.kind !== 'spawn-ravel') throw new Error('unreachable')
      expect(action.request.harness).toBe('zai')
    })

    it('keeps an explicit harness rather than the default', () => {
      const action = revisionToLaunch(
        revision({ kind: 'schedule', harness: 'codex' }),
        { repoPath: 'D:/repo', defaultHarness: 'zai' }
      )
      if (action.kind !== 'spawn-ravel') throw new Error('unreachable')
      expect(action.request.harness).toBe('codex')
    })

    it('normalizes a null model to undefined (never null)', () => {
      const action = revisionToLaunch(revision({ kind: 'schedule', model: null }), ctx)
      if (action.kind !== 'spawn-ravel') throw new Error('unreachable')
      expect(action.request.model).toBeUndefined()
      expect(action.request.model).not.toBeNull()
    })

    it('forwards a concrete model string', () => {
      const action = revisionToLaunch(revision({ kind: 'schedule', model: 'o3' }), ctx)
      if (action.kind !== 'spawn-ravel') throw new Error('unreachable')
      expect(action.request.model).toBe('o3')
    })

    it('maps title->name, prompt->initialInstruction, repoId, repoPath verbatim', () => {
      const action = revisionToLaunch(
        revision({ kind: 'schedule', title: 'Deploy', prompt: 'ship it', repoId: 'r' }),
        { repoPath: '/srv/r', defaultHarness: 'claude' }
      )
      if (action.kind !== 'spawn-ravel') throw new Error('unreachable')
      expect(action.request.name).toBe('Deploy')
      expect(action.request.initialInstruction).toBe('ship it')
      expect(action.request.repoId).toBe('r')
      expect(action.request.repoPath).toBe('/srv/r')
    })

    it('pins allowRisky to false and omits maxChildren', () => {
      const action = revisionToLaunch(revision({ kind: 'schedule' }), ctx)
      if (action.kind !== 'spawn-ravel') throw new Error('unreachable')
      expect(action.request.allowRisky).toBe(false)
      expect(action.request.maxChildren).toBeUndefined()
    })
  })

  describe('wake-target', () => {
    it('maps a heartbeat with a non-empty targetId to a wake-target action', () => {
      const action = revisionToLaunch(
        revision({ kind: 'heartbeat', targetId: 'ravel-7', prompt: 'keep going' }),
        ctx
      )
      expect(action).toEqual({ kind: 'wake-target', targetId: 'ravel-7', prompt: 'keep going' })
    })

    it('does not consult harness/model/repoPath for a wake-target', () => {
      const action = revisionToLaunch(
        revision({ kind: 'heartbeat', targetId: 'session-1', harness: 'codex', model: 'o3' }),
        ctx
      )
      expect(action.kind).toBe('wake-target')
    })
  })

  describe('heartbeat falls through to spawn-ravel when there is no target', () => {
    it('with a null targetId', () => {
      const action = revisionToLaunch(revision({ kind: 'heartbeat', targetId: null }), ctx)
      expect(action.kind).toBe('spawn-ravel')
    })

    it('with an empty-string targetId', () => {
      const action = revisionToLaunch(revision({ kind: 'heartbeat', targetId: '' }), ctx)
      expect(action.kind).toBe('spawn-ravel')
      if (action.kind !== 'spawn-ravel') throw new Error('unreachable')
      expect(action.request.initialInstruction).toBe('run the suite')
    })
  })
})
