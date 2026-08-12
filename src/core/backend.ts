// The Conductor backend, assembled for the standalone Core process.
//
// This relocates the orchestration wiring that used to live in the Electron
// main process (`src/main/index.ts`): the store, git, sessions, ravel,
// roundtable, insight, activity, harness and Operations Core singletons, plus
// the handler table the renderer drives. It is Electron-FREE — events are
// pushed through an injected `emit` (the control channel's fan-out) instead of a
// BrowserWindow, and every path uses `os.homedir()` / an injected data dir
// rather than Electron's `app`. The handler method names are the exact IPC
// channel strings, so the Electron client proxies each `ipcMain.handle(ch, …)`
// to `coreClient.call(ch, …)` with no renaming.

import { readFileSync, writeFileSync, readdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { store } from '../main/store'
import * as git from '../main/git'
import { detectHarnesses, resolveModelCatalogues } from '../main/harness'
import { startActivityWatch, stopActivityWatch, syncActivityWatch } from '../main/activity'
import { InsightCoordinator } from '../main/insights/coordinator'
import { collectDispatches } from '../main/insights/collect-dispatches'
import * as sessions from '../main/sessions'
import * as ravel from '../main/ravel'
import { runHook } from '../main/hooks'
import * as roundtable from '../main/roundtable'
import {
  invalidRavelRequest,
  parseCreateNormalSessionRequest,
  parseCreateRoundtableRequest,
  parseCreateRavelRequest,
  parseRavelBriefMutation,
  parseRavelId,
  parseRavelMessage,
  parseRavelSteer,
  parseRavelPlanMessage,
  parseRavelPlanRevision,
  ravelReadFallback,
  parseUpdateRavelBriefAssignment
} from '../main/ravel-ipc'
import { createOperationsCore } from '../main/operations/core'
import type { OperationsCore, PairingInfo } from '../main/operations/core'
import type { ControlHandlers } from './control-protocol'
import type {
  CreateWorktreeRequest,
  DeleteBranchResult,
  MergeBranchResult,
  MergeOptions,
  MergePreviewResult,
  Repo,
  RavelActionResult,
  RavelLogEntry,
  RoundtableConfig,
  Settings
} from '@shared/types'

export type EmitFn = (channel: string, ...args: unknown[]) => void

export interface CoreBackend {
  /** Method-name → handler table for the control server (keys are IPC channels). */
  handlers: ControlHandlers
  /** Bind the control channel's event fan-out; wires session/ravel/roundtable emitters. */
  bindEmit(emit: EmitFn): void
  /** Reattach ravels, arm activity watching, and start the Operations Core web server. */
  start(): Promise<void>
  /** Stop the web server, disarm watching, and reap every live child. */
  stop(): Promise<void>
  /** Pairing details for the remote web client (LAN URL + token + code). */
  pairingInfo(): PairingInfo
}

export interface CoreBackendOptions {
  /** Versioned Core data dir; the Operations Core stores its journal/automations here. */
  dataDir: string
  /** Version string reported in the operations handshake. */
  version: string
  /** Directory of the built web client to serve same-origin with the operations API. */
  webStaticDir: string
  webPort: number
  webHost: string
  webToken?: string
  /** TLS override; non-loopback binds default to TLS and reject an explicit false. */
  webTls?: boolean
}

interface DirEntry {
  name: string
  path: string
  isDir: boolean
}

/** One-level directory listing for the file viewer. Hides noise dirs. */
function listDir(dir: string): DirEntry[] {
  const HIDDEN = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.turbo', '.cache'])
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => !HIDDEN.has(e.name))
      .map((e) => ({ name: e.name, path: join(dir, e.name), isDir: e.isDirectory() }))
      .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

export function createBackend(opts: CoreBackendOptions): CoreBackend {
  const defaultWorktreeRoot = (): string => join(homedir(), '.conductor', 'worktrees')
  const resolveWorktreeRoot = (): string => store.getSettings().worktreeRoot || defaultWorktreeRoot()
  // The event fan-out; replaced by the real one in bindEmit. Declared first so
  // the closures below (insights, emitAndObserve) read the live value.
  let emit: EmitFn = () => {}

  function canonicalPathForAccess(filePath: string): string {
    try {
      return realpathSync.native(filePath)
    } catch {
      return join(realpathSync.native(dirname(filePath)), basename(filePath))
    }
  }

  function allowedFilePath(pathValue: unknown): string {
    if (typeof pathValue !== 'string' || pathValue.length === 0) {
      throw new Error('file path must be a non-empty absolute path')
    }
    if (!isAbsolute(pathValue)) {
      throw new Error('file path must be a non-empty absolute path')
    }
    if (/(^|[\\/])\.\.([\\/]|$)/.test(pathValue) || pathValue.includes('\0')) {
      throw new Error('file path traversal is not allowed')
    }

    const target = canonicalPathForAccess(resolve(pathValue))
    const roots = [
      opts.dataDir,
      ...store.getRepos().map((repo) => repo.path),
      ...Object.keys(store.getWorktrees())
    ]
    const insideRoot = roots.some((root) => {
      try {
        const relation = relative(realpathSync.native(resolve(root)), target)
        const outside = relation === '..' || relation.startsWith('..\\') || relation.startsWith('../') || isAbsolute(relation)
        return relation === '' || !outside
      } catch {
        return false
      }
    })
    if (!insideRoot) throw new Error(`file path is outside allowed roots: ${pathValue}`)
    return target
  }
  const operationsCore: OperationsCore = createOperationsCore({
    dataDir: opts.dataDir,
    coreVersion: opts.version,
    webPort: opts.webPort,
    webHost: opts.webHost,
    webToken: opts.webToken,
    webTls: opts.webTls,
    webStaticDir: opts.webStaticDir,
    getRepos: () => store.getRepos(),
    getSettings: () => store.getSettings(),
    listRavel: () => ravel.listRavel(),
    getRavel: (id) => ravel.getRavel(id),
    getSession: (id) => sessions.getSession(id),
    ravel: {
      steerChild: ravel.steerChild,
      pauseRavel: ravel.pauseRavel,
      resumeRavel: ravel.resumeRavel,
      resumeInterruptedBrief: ravel.resumeInterruptedBrief,
      archiveDispatch: ravel.archiveDispatch,
      detachChild: ravel.detachChild
    },
    killSession: (id) => sessions.killSession(id),
    writeToSession: (id, data) => sessions.writeToSession(id, data),
    git: {
      currentBranch: git.currentBranch,
      resolveCommit: git.resolveCommit,
      changedFiles: git.changedFiles,
      mergeBranch: git.mergeBranch,
      reviewFileList: git.reviewFileList,
      fileUnifiedDiff: git.fileUnifiedDiff
    },
    scheduler: {
      defaultHarness: 'claude',
      createRavel: async (request) => {
        const existing = ravel.listRavel().find((candidate) => candidate.repoId === request.repoId)
        if (existing) {
          if (request.initialInstruction) {
            const wake = await ravel.sendMessage(existing.id, request.initialInstruction, store.getSettings())
            if (!wake || !wake.ok) return { ravelId: existing.id, error: wake?.error.message ?? wake?.error.code }
          }
          return { ravelId: existing.id }
        }
        const result = await ravel.createRavel(request, store.getSettings())
        return result.ok ? { ravelId: result.ravel.id } : { ravelId: null, error: result.error.message ?? result.error.code }
      },
      wakeTarget: async (targetId, prompt) => {
        const result = await ravel.sendMessage(targetId, prompt, store.getSettings())
        if (!result) return { error: 'target not found' }
        return result.ok ? {} : { error: result.error.message ?? result.error.code }
      }
    }
  })

  const insights = new InsightCoordinator({
    loadState: () => store.getInsightState(),
    saveState: (state) => {
      store.saveInsightState(state)
    },
    emit: (insight) => emit('insight:update', insight),
    listSessions: () => sessions.listSessions(),
    activeRavel: (id) => ravel.getRavel(id) ?? null,
    collectDispatches,
    now: () => Date.now()
  })
  ravel.setInsightNotifier((trigger, ravelId) => insights.note(trigger, ravelId))
  sessions.setInsightNotifier((trigger, ravelId) => insights.note(trigger, ravelId))

  /** Broadcast to clients AND tee timeline-relevant activity into the Operations Core feed. */
  function emitAndObserve(channel: string, ...args: unknown[]): void {
    emit(channel, ...args)
    if (channel === 'ravel:log') operationsCore.observeRavelLog(args[0] as RavelLogEntry)
    else if (channel === 'roundtable:update') operationsCore.observeRoundtable(args[0] as RoundtableConfig)
  }

  function bindEmit(next: EmitFn): void {
    emit = next
    sessions.setSessionEvents({
      data: (id, data, generation) => emit('pty:data', id, data, generation),
      created: () => syncActivityWatch(),
      exit: (id, result) => {
        const session = sessions.getSession(id)
        emit('pty:exit', id, result.exitCode)
        ravel.onSessionExit(id, result)
        if (session) operationsCore.observeSessionExit(session, result.exitCode)
        syncActivityWatch()
      },
      progress: (id, deltaChars) => ravel.onSessionProgress(id, deltaChars),
      status: (id, status) => {
        emit('session:status', id, status)
        const session = sessions.getSession(id)
        if (session) operationsCore.observeSessionStatus(session, status)
        syncActivityWatch()
      }
    })
    ravel.setRavelContext({ resolveWorktreeRoot, emit: emitAndObserve, detectHarnesses })
    roundtable.setRoundtableEmitter(emitAndObserve)
  }

  const handlers: ControlHandlers = {
    'insight:getCurrent': () => insights.current(),
    'insight:dismiss': () => {
      insights.dismiss()
    },

    'repo:list': () => store.getRepos(),
    'repo:add': async (path) => {
      const repoPath = path as string
      if (!(await git.isRepo(repoPath))) throw new Error(`Not a git repository: ${repoPath}`)
      const name = await git.repoName(repoPath)
      const repo: Repo = { id: randomUUID(), path: repoPath, name, addedAt: Date.now() }
      return store.addRepo(repo)
    },
    'repo:remove': (id) => {
      store.removeRepo(id as string)
      return true
    },

    'branch:list': (repoPath) => git.listBranches(repoPath as string),
    'branch:current': (repoPath) => git.currentBranch(repoPath as string),
    'worktree:list': async (repoPath) => {
      const list = await git.listWorktrees(repoPath as string)
      const tracked = store.getWorktrees()
      return list.map((w) => ({ ...w, conductor: !!tracked[w.path] }))
    },
    'worktree:create': async (payload) => {
      const req = payload as CreateWorktreeRequest & { repoId: string }
      const root = resolveWorktreeRoot()
      const targetPath = git.worktreePathFor(req.repoPath, req.branch, root)
      await git.createWorktree(req.repoPath, req.branch, {
        baseBranch: req.baseBranch,
        newBranch: req.newBranch,
        targetPath
      })
      store.trackWorktree(targetPath, { repoId: req.repoId, repoPath: req.repoPath, branch: req.branch })
      const settings = store.getSettings()
      const scripts = [settings.hooks.global, settings.hooks.perRepo[req.repoId]].filter(
        (s): s is string => !!s && s.trim().length > 0
      )
      if (scripts.length > 0) {
        // Hooks are arbitrary user shell run at full privilege: they run only
        // after the operator has granted one-time shell-execution consent.
        // Without consent they are skipped and the skip is surfaced, never run
        // silently.
        if (!settings.shellHooksConsented) {
          emit('hook:result', {
            worktreePath: targetPath,
            ok: false,
            exitCode: null,
            stdout: '',
            stderr: 'post-create hook skipped — enable shell execution consent in Settings',
            ranWith: 'skipped'
          })
        } else {
          const combined = scripts.join('\n')
          runHook(combined, { worktreePath: targetPath, repoPath: req.repoPath, branch: req.branch })
            .then((res) => emit('hook:result', { worktreePath: targetPath, ...res }))
            .catch(() => {
              /* hook errors are surfaced to the client via the hook:result event */
            })
        }
      }
      return { path: targetPath, branch: req.branch }
    },
    'worktree:remove': async (payload) => {
      const p = payload as { repoPath: string; targetPath: string; deleteBranch?: string }
      await git.removeWorktree(p.repoPath, p.targetPath, { force: true, deleteBranch: p.deleteBranch })
      store.untrackWorktree(p.targetPath)
      return true
    },

    'merge:preview': async (payload): Promise<MergePreviewResult> => {
      const p = payload as { repoPath: string; branches: string[]; baseBranch: string }
      try {
        return await git.mergePreview(p.repoPath, p.branches, p.baseBranch)
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    },
    'merge:land': async (payload): Promise<MergeBranchResult> => {
      const p = payload as { repoPath: string; branch: string; baseBranch: string; options?: MergeOptions }
      try {
        return await git.mergeBranch(p.repoPath, p.branch, p.baseBranch, p.options ?? {})
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e), restored: true }
      }
    },
    'merge:deleteBranch': async (payload): Promise<DeleteBranchResult> => {
      const p = payload as { repoPath: string; branch: string }
      try {
        return await git.deleteMergedBranch(p.repoPath, p.branch)
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    },

    'harness:detect': () => detectHarnesses(store.getSettings()),
    'harness:modelCatalogues': () => resolveModelCatalogues(store.getSettings()),

    'session:create': async (payload) => {
      const parsed = parseCreateNormalSessionRequest(payload)
      if (!parsed.ok) throw new Error(parsed.error.message ?? 'Invalid session create request.')
      const req = parsed.value
      let worktreePath = req.worktreePath
      let branch = req.branch
      if (req.createWorktree) {
        const root = resolveWorktreeRoot()
        const target = git.worktreePathFor(req.repoPath, req.createWorktree.branch, root)
        await git.createWorktree(req.repoPath, req.createWorktree.branch, {
          baseBranch: req.createWorktree.baseBranch,
          newBranch: req.createWorktree.newBranch,
          targetPath: target
        })
        store.trackWorktree(target, { repoId: req.repoId, repoPath: req.repoPath, branch: req.createWorktree.branch })
        worktreePath = target
        branch = req.createWorktree.branch
      }
      return sessions.createSession({ ...req, kind: 'normal', worktreePath, branch }, store.getSettings())
    },
    'session:list': () => sessions.listSessions(),
    'session:write': (id, data) => sessions.writeToSession(id as string, data as string),
    'session:resize': (id, cols, rows) => sessions.resizeSession(id as string, cols as number, rows as number),
    'session:kill': (id) => sessions.killSession(id as string),
    'session:snapshot': (id) => (typeof id === 'string' ? sessions.snapshotSession(id) : null),

    'settings:get': () => store.getSettings(),
    'settings:save': (patch) => store.saveSettings(patch as Partial<Settings>),
    'settings:loadError': () => {
      const error = store.getLoadError()
      return error === null ? null : error.message
    },
    'store:reset': () => store.reset(),
    'store:export': (destinationFile) => {
      if (typeof destinationFile !== 'string') throw new Error('export path must be a string')
      return store.exportTo(destinationFile)
    },
    'store:import': (sourceFile) => {
      if (typeof sourceFile !== 'string') throw new Error('import path must be a string')
      return store.importFrom(sourceFile)
    },

    'system:readFile': (p) => {
      const filePath = allowedFilePath(p)
      try {
        return readFileSync(filePath, 'utf8')
      } catch {
        return null
      }
    },
    'system:writeFile': (p, content) => {
      const filePath = allowedFilePath(p)
      if (typeof content !== 'string') throw new Error('file content must be a string')
      try {
        writeFileSync(filePath, content, 'utf8')
        return true
      } catch (e) {
        console.error('[core] writeFile failed', filePath, e)
        return false
      }
    },
    'fs:listDir': (p) => listDir(p as string),

    'operations:pairing': () => operationsCore.pairingInfo(),

    'ravel:create': async (payload): Promise<RavelActionResult> => {
      const parsed = parseCreateRavelRequest(payload, store.getRepos())
      if (!parsed.ok) return invalidRavelRequest(parsed.error)
      if (!(await git.isRepo(parsed.value.repoPath))) {
        return { ok: false, error: { code: 'invalid-repository', message: 'Repository is not available.' } }
      }
      const existing = ravel.listRavel().find((candidate) => candidate.repoId === parsed.value.repoId)
      if (existing) {
        // A second Reigen for the same repo reuses the singleton. The operator's
        // initial instruction is delivered as a wake-up message, mirroring the
        // operations path — silently dropping it would lose typed input.
        if (parsed.value.initialInstruction) {
          const woken = await ravel.sendMessage(existing.id, parsed.value.initialInstruction, store.getSettings())
          if (!woken) return { ok: false, error: { code: 'ravel-missing', message: 'Existing Reigen could not be reached.' } }
          if (!woken.ok) return woken
          return woken
        }
        return { ok: true, ravel: existing }
      }
      return ravel.createRavel(parsed.value, store.getSettings())
    },
    'ravel:list': () => ravel.listRavel(),
    'ravel:get': (id) => {
      const parsed = parseRavelId(id)
      return parsed.ok ? (ravel.getRavel(parsed.value) ?? null) : ravelReadFallback('get')
    },
    'ravel:log': (id) => {
      const parsed = parseRavelId(id)
      return parsed.ok ? ravel.getLog(parsed.value) : ravelReadFallback('log')
    },
    'ravel:children': (id) => {
      const parsed = parseRavelId(id)
      return parsed.ok ? ravel.childrenOf(parsed.value) : ravelReadFallback('children')
    },
    'ravel:sendMessage': async (id, body) => {
      const parsed = parseRavelMessage(id, body)
      return parsed.ok ? ((await ravel.sendMessage(parsed.value.id, parsed.value.body, store.getSettings())) ?? null) : invalidRavelRequest(parsed.error)
    },
    'ravel:updateBriefAssignment': async (id, planRevision, briefId, assignment) => {
      const parsed = parseUpdateRavelBriefAssignment(id, planRevision, briefId, assignment)
      return parsed.ok
        ? ((await ravel.applyBriefAssignment(parsed.value.id, parsed.value.planRevision, parsed.value.briefId, parsed.value.assignment, store.getSettings())) ?? null)
        : invalidRavelRequest(parsed.error)
    },
    'ravel:requestPlanChanges': async (id, planRevision, body) => {
      const parsed = parseRavelPlanMessage(id, planRevision, body)
      return parsed.ok
        ? ((await ravel.requestPlanChanges(parsed.value.id, parsed.value.planRevision, parsed.value.body, store.getSettings())) ?? null)
        : invalidRavelRequest(parsed.error)
    },
    'ravel:approvePlan': async (id, planRevision) => {
      const parsed = parseRavelPlanRevision(id, planRevision)
      return parsed.ok ? ((await ravel.approvePlan(parsed.value.id, parsed.value.planRevision, store.getSettings())) ?? null) : invalidRavelRequest(parsed.error)
    },
    'ravel:retryCompilation': async (id) => {
      const parsed = parseRavelId(id)
      return parsed.ok ? ((await ravel.retryCompilation(parsed.value, store.getSettings())) ?? null) : invalidRavelRequest(parsed.error)
    },
    'ravel:resumeInterruptedBrief': async (id, planRevision, briefId) => {
      const parsed = parseRavelBriefMutation(id, planRevision, briefId)
      return parsed.ok
        ? ((await ravel.resumeInterruptedBrief(parsed.value.id, parsed.value.planRevision, parsed.value.briefId, store.getSettings())) ?? null)
        : invalidRavelRequest(parsed.error)
    },
    'ravel:steerChild': async (id, sessionId, note) => {
      const parsed = parseRavelSteer(id, sessionId, note)
      return parsed.ok
        ? ((await ravel.steerChild(parsed.value.id, parsed.value.sessionId, parsed.value.note, store.getSettings())) ?? null)
        : invalidRavelRequest(parsed.error)
    },
    'ravel:claimBrief': async (id, planRevision, briefId) => {
      const parsed = parseRavelBriefMutation(id, planRevision, briefId)
      return parsed.ok
        ? ((await ravel.claimBrief(parsed.value.id, parsed.value.planRevision, parsed.value.briefId, store.getSettings())) ?? null)
        : invalidRavelRequest(parsed.error)
    },
    'ravel:askFromSeat': (sessionId, question) => {
      if (typeof sessionId !== 'string' || typeof question !== 'string') return false
      return ravel.askFromSeat(sessionId, question)
    },
    'ravel:finishSeat': (sessionId, report, failed) => {
      if (typeof sessionId !== 'string' || typeof report !== 'string') return false
      return ravel.finishSeat(sessionId, report, failed === true)
    },
    'ravel:pause': (id): RavelActionResult | null => {
      const parsed = parseRavelId(id)
      if (!parsed.ok) return invalidRavelRequest(parsed.error)
      const cfg = ravel.pauseRavel(parsed.value)
      return cfg ? { ok: true, ravel: cfg } : null
    },
    'ravel:resume': async (id): Promise<RavelActionResult | null> => {
      const parsed = parseRavelId(id)
      if (!parsed.ok) return invalidRavelRequest(parsed.error)
      const existing = ravel.getRavel(parsed.value)
      if (!existing) return null
      const cfg = await ravel.resumeRavel(parsed.value, store.getSettings())
      return cfg ? { ok: true, ravel: cfg } : { ok: false, error: { code: 'ravel-closing', message: 'Ravel is closing.' } }
    },
    'ravel:delete': async (id): Promise<RavelActionResult | null> => {
      const parsed = parseRavelId(id)
      if (!parsed.ok) return invalidRavelRequest(parsed.error)
      const existing = ravel.getRavel(parsed.value)
      if (!existing) return null
      await ravel.deleteRavel(parsed.value)
      return { ok: true, ravel: existing }
    },

    'roundtable:list': () => roundtable.listRoundtables(),
    'roundtable:get': (id) => (typeof id === 'string' ? (roundtable.getRoundtable(id) ?? null) : null),
    'roundtable:create': (req) => {
      const parsed = parseCreateRoundtableRequest(req, store.getRepos())
      return parsed.ok ? roundtable.createRoundtable(parsed.value) : { ok: false, error: { code: 'invalid-request', message: parsed.error } }
    },
    'roundtable:start': async (id) => {
      if (typeof id !== 'string') return { ok: false, error: { code: 'invalid-request', message: 'id is required.' } }
      return roundtable.runRoundtable(id, store.getSettings())
    },
    'roundtable:pause': (id) =>
      typeof id === 'string' ? roundtable.pauseRoundtable(id) : { ok: false, error: { code: 'invalid-request', message: 'id is required.' } },
    'roundtable:note': (id, body) =>
      typeof id === 'string' && typeof body === 'string'
        ? roundtable.addNote(id, body)
        : { ok: false, error: { code: 'invalid-request', message: 'id and body are required.' } },
    'roundtable:delete': (id) => {
      if (typeof id === 'string') roundtable.deleteRoundtable(id)
    }
  }

  return {
    handlers,
    bindEmit,
    async start() {
      // Load the persisted store from disk BEFORE anything reads it. Without this
      // the Core runs on an empty in-memory store and the first write persists
      // that emptiness over the user's real data. A parse failure starts
      // read-only (the store refuses writes) rather than taking the Core down.
      try {
        store.init()
      } catch (error) {
        console.error('[core] store load failed; starting read-only', error)
      }
      ravel.reattachOnStartup()
      startActivityWatch(
        () => sessions.listSessions(),
        (entries) => {
          emit('session:activity', entries)
          operationsCore.observeFileActivity(entries)
        }
      )
      await operationsCore.start()
    },
    async stop() {
      stopActivityWatch()
      await operationsCore.stop()
      sessions.killAllSessions()
    },
    pairingInfo: () => operationsCore.pairingInfo()
  }
}
