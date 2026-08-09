// LAUNCH slice of the Operations Core automation subsystem (Release A).
//
// Pure mapping from an approved automation revision to the concrete launch
// action a tick's `spawnable` entry should perform: spawn a fresh Ravel, or wake
// an existing target. Nothing here reads the clock, the filesystem, or the
// store — the filesystem path for `revision.repoId` is resolved by the caller
// and injected through LaunchContext, as is the fallback harness when the
// revision leaves harness null.
//
// revisionToLaunch is a total function over AutomationRevision:
//   - a heartbeat with a concrete (non-empty) targetId wakes that target;
//   - everything else (every schedule, and a heartbeat with a null/empty
//     target) spawns a new Ravel built from the revision's launch fields.
//
// The spawn request deliberately omits `maxChildren` (letting it default) and
// normalizes a null model to undefined so the request matches CreateRavelRequest
// exactly — `model?: string` is absent-or-undefined, never null.

import type { CreateRavelRequest, HarnessId } from '@shared/types'
import type { AutomationRevision } from './types'

export type LaunchAction =
  | { kind: 'spawn-ravel'; request: CreateRavelRequest }
  | { kind: 'wake-target'; targetId: string; prompt: string }

export interface LaunchContext {
  /** Filesystem path for revision.repoId, already resolved by the caller. */
  repoPath: string
  /** Harness to use when the revision leaves harness null. */
  defaultHarness: HarnessId
}

/**
 * Decide what to launch for a revision under the given context. Pure: the only
 * inputs are the (immutable) revision and the caller-resolved context.
 */
export function revisionToLaunch(revision: AutomationRevision, ctx: LaunchContext): LaunchAction {
  if (revision.kind === 'heartbeat' && typeof revision.targetId === 'string' && revision.targetId.length > 0) {
    return { kind: 'wake-target', targetId: revision.targetId, prompt: revision.prompt }
  }

  return {
    kind: 'spawn-ravel',
    request: {
      name: revision.title,
      repoId: revision.repoId,
      repoPath: ctx.repoPath,
      harness: revision.harness ?? ctx.defaultHarness,
      model: revision.model ?? undefined,
      initialInstruction: revision.prompt,
      allowRisky: false
    }
  }
}
