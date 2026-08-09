// End-to-end wiring test for the Operations Core assembly (./core).
//
// The pure layers (journal, feed, normalizer, adapter, transport) are unit
// tested elsewhere. This test proves the ASSEMBLY: that createOperationsCore
// stands up a real loopback HTTP+SSE server speaking the api-contract over the
// real journal/feed/store, and that the CoreDeps this module implements against
// injected app singletons behave — worker detail/controls, review land with its
// staleness rechecks, and the live-feed observation hooks turning app activity
// into queryable timeline events.
//
// It uses fakes for the app singletons (ravel/sessions/git) but a REAL journal
// and automation store on a temp dir, and drives the command/query/handshake
// surface over an actual socket via fetch — the same path a remote browser uses.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  MergeBranchResult,
  PublicRavelConfig,
  RavelDispatchRecord,
  RavelLogEntry,
  Repo,
  Session,
  Settings
} from '@shared/types'
import { createOperationsCore } from './core'
import type { OperationsCore, OperationsCoreDeps } from './core'
import { reviewDiffDigest } from './review-digest'

const REPO: Repo = { id: 'repo-1', path: '/repos/demo', name: 'demo', addedAt: 0 }

function dispatch(over: Partial<RavelDispatchRecord> = {}): RavelDispatchRecord {
  return {
    briefId: 'brief-1',
    planRevision: 1,
    sessionId: 'sess-1',
    branch: 'ravel/brief-1',
    worktreePath: '/wt/brief-1',
    status: 'active',
    startedAt: 1,
    endedAt: null,
    baseCommit: 'base000',
    usage: { inputTokens: 0, outputTokens: 0, costUsd: null },
    report: null,
    contextRequests: 0,
    verification: null,
    ...over
  }
}

function ravelCfg(over: Partial<PublicRavelConfig> = {}): PublicRavelConfig {
  return {
    id: 'ravel-1',
    name: 'Demo',
    repoId: REPO.id,
    repoPath: REPO.path,
    harness: 'claude',
    model: null,
    maxChildren: 4,
    allowRisky: false,
    status: 'running',
    activity: 'thinking',
    managerSessionId: null,
    messages: [],
    plan: {
      revision: 1,
      createdAt: 0,
      sourceMessageIds: [],
      mission: { goal: 'x', context: [], constraints: [], acceptanceCriteria: [], assumptions: [] },
      orientation: 'o',
      briefs: [
        {
          id: 'brief-1',
          title: 'B1',
          role: 'lead-engineer',
          harness: 'codex',
          model: 'gpt-5.1',
          phase: 'implementation',
          goal: 'g',
          relevantContext: [],
          constraints: [],
          acceptanceCriteria: [],
          doNotTouch: [],
          expectedOutput: 'e',
          escalationConditions: [],
          dependsOn: [],
          contextExceptionReason: null
        }
      ],
      approvedAt: 0,
      approvedRevision: 1
    },
    dispatches: [dispatch()],
    createdAt: 0,
    error: null,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: null },
    ...over
  } as PublicRavelConfig
}

function childSession(over: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    repoId: REPO.id,
    repoPath: REPO.path,
    worktreePath: '/wt/brief-1',
    branch: 'ravel/brief-1',
    status: 'running',
    title: null,
    initialPrompt: null,
    createdAt: 0,
    lastActivityAt: 0,
    kind: 'ravel-child',
    harness: 'codex',
    parentId: null,
    ravelId: 'ravel-1',
    ravelRole: 'lead-engineer',
    briefId: 'brief-1',
    ...over
  } as Session
}

/** A fully defaulted deps object; individual tests override the pieces they exercise. */
function makeDeps(dataDir: string, over: Partial<OperationsCoreDeps> = {}): OperationsCoreDeps {
  return {
    dataDir,
    coreVersion: '9.9.9',
    webPort: 0,
    getRepos: () => [REPO],
    getSettings: () => ({}) as Settings,
    listRavel: () => [],
    getRavel: () => undefined,
    getSession: () => undefined,
    ravel: {
      steerChild: vi.fn(async () => ({ ok: true as const, ravel: ravelCfg() })),
      pauseRavel: vi.fn(() => ravelCfg({ status: 'paused' })),
      resumeRavel: vi.fn(async () => ravelCfg()),
      resumeInterruptedBrief: vi.fn(async () => ({ ok: true as const, ravel: ravelCfg() })),
      archiveDispatch: vi.fn(() => ravelCfg()),
      detachChild: vi.fn(async () => ravelCfg())
    },
    killSession: vi.fn(() => true),
    writeToSession: vi.fn(() => true),
    git: {
      currentBranch: vi.fn(async () => 'main'),
      resolveCommit: vi.fn(async () => 'unset'),
      changedFiles: vi.fn(async () => []),
      mergeBranch: vi.fn(async () => ({
        ok: true,
        branch: 'ravel/brief-1',
        commit: 'merged01',
        alreadyMerged: false,
        files: ['a.ts'],
        warning: null
      }) as MergeBranchResult),
      reviewFileList: vi.fn(async () => []),
      fileUnifiedDiff: vi.fn(async () => '')
    },
    ...over
  }
}

describe('createOperationsCore (assembly)', () => {
  let dir: string
  let core: OperationsCore | null = null
  let base: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ops-core-'))
  })

  afterEach(async () => {
    if (core) await core.stop()
    core = null
    rmSync(dir, { recursive: true, force: true })
  })

  async function start(deps: OperationsCoreDeps): Promise<string> {
    core = createOperationsCore(deps)
    const port = await core.start()
    base = `http://127.0.0.1:${port}`
    return base
  }

  async function post(path: string, body: unknown): Promise<any> {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
    return res.json()
  }

  it('serves the handshake over a real loopback socket', async () => {
    await start(makeDeps(dir))
    const hs = await (await fetch(`${base}/api/handshake`)).json()
    expect(hs.apiVersion).toBe(1)
    expect(hs.coreVersion).toBe('9.9.9')
    expect(hs.storeSchemaVersion).toBe(2)
    expect(hs.cursor).toBe(0)
    expect(hs.capabilities).toContain('review.decide')
  })

  it('defaults non-loopback binds to HTTPS and includes the certificate pin', async () => {
    await start(makeDeps(dir, { webHost: '0.0.0.0' }))
    const info = core!.pairingInfo()
    expect(info.url).toMatch(/^https:\/\/.+/)
    const decoded = JSON.parse(Buffer.from(info.code!.slice(3), 'base64url').toString('utf8'))
    expect(decoded.f).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
  })

  it('allows an explicit cleartext opt-out on a non-loopback bind, with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      expect(() =>
        createOperationsCore(makeDeps(dir, { webHost: '0.0.0.0', webTls: false }))
      ).not.toThrow()
      expect(warn.mock.calls.map((args) => args.join(' ')).join('\n')).toMatch(/CLEARTEXT/)
    } finally {
      warn.mockRestore()
    }
  })
  it('keeps configured web tokens out of logs and endpoint hints', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      await start(makeDeps(dir, { webToken: 'tok-secret' }))
      const info = core!.pairingInfo()
      expect(info.token).toBe('tok-secret')

      const endpoint = JSON.parse(readFileSync(join(dir, 'web-endpoint.json'), 'utf8')) as Record<string, unknown>
      expect(endpoint).toEqual({ host: '127.0.0.1', port: core!.port(), scheme: 'http' })

      const output = log.mock.calls.map((args) => args.join(' ')).join('\n')
      expect(output).toContain('access token configured')
      expect(output).not.toContain('tok-secret')
    } finally {
      log.mockRestore()
    }
  })

  it('emits a pairing code that decodes to the core URL + token', async () => {
    await start(makeDeps(dir, { webToken: 'tok-123' }))
    const port = core!.port()
    const info = core!.pairingInfo()
    expect(info.token).toBe('tok-123')
    expect(info.url).toBe(`http://127.0.0.1:${port}`)
    expect(info.code?.startsWith('C1:')).toBe(true)
    // The desktop-generated code must decode the way the client's decodePairing reads it.
    const decoded = JSON.parse(Buffer.from(info.code!.slice(3), 'base64url').toString('utf8'))
    expect(decoded).toEqual({ u: `http://127.0.0.1:${port}`, t: 'tok-123' })
  })

  it('turns an observed ravel log entry into a queryable timeline event', async () => {
    const deps = makeDeps(dir, { getRavel: () => ravelCfg() })
    await start(deps)

    const before = await post('/api/query', { name: 'timeline.read', afterCursor: 0 })
    expect(before.events).toHaveLength(0)

    const entry: RavelLogEntry = {
      id: 'log-1',
      ravelId: 'ravel-1',
      ts: 123,
      level: 'action',
      event: 'spawn',
      childSessionId: 'sess-1',
      text: 'spawned brief-1'
    }
    core!.observeRavelLog(entry)

    const after = await post('/api/query', { name: 'timeline.read', afterCursor: 0 })
    expect(after.events).toHaveLength(1)
    expect(after.events[0]).toMatchObject({
      cursor: 1,
      kind: 'lifecycle',
      summary: 'spawned brief-1',
      workerKind: 'ravel-child',
      role: 'lead-engineer',
      harness: 'codex'
    })
  })

  it.skipIf(!existsSync(resolve(process.cwd(), 'out/web', 'index.html')))(
    'serves the built web client (out/web) with SPA fallback, alongside the live API',
    async () => {
      const webDir = resolve(process.cwd(), 'out/web')
      await start(makeDeps(dir, { webStaticDir: webDir, getRavel: () => ravelCfg() }))

      const index = await fetch(`${base}/`)
      expect(index.status).toBe(200)
      const html = await index.text()
      expect(html).toContain('id="root"')
      expect(html).toContain('Conductor')

      // The referenced JS asset is served with a JS content-type.
      const assetPath = html.match(/(\/assets\/[^"']+\.js)/)?.[1]
      expect(assetPath).toBeTruthy()
      const asset = await fetch(`${base}${assetPath}`)
      expect(asset.status).toBe(200)
      expect(asset.headers.get('content-type')).toContain('javascript')

      // A deep client route falls back to index.html so the SPA boots.
      const route = await fetch(`${base}/workers`)
      expect(route.status).toBe(200)
      expect(await route.text()).toContain('id="root"')

      // The live API still answers alongside the static client.
      core!.observeRavelLog({
        id: 'log-x',
        ravelId: 'ravel-1',
        ts: 1,
        level: 'action',
        event: 'spawn',
        childSessionId: 'sess-1',
        text: 'spawned'
      })
      const tl = await post('/api/query', { name: 'timeline.read', afterCursor: 0 })
      expect(tl.events.length).toBeGreaterThanOrEqual(1)
    }
  )

  it('persists an automation via the command path and lists it back', async () => {
    await start(makeDeps(dir))
    const definition = {
      id: 'auto-1',
      currentRevisionId: 'rev-1',
      revisions: [
        {
          id: 'rev-1',
          kind: 'schedule' as const,
          title: 'Morning check',
          enabled: true,
          cadence: { expression: '0 9 * * *', timezone: 'UTC' },
          targetId: null,
          prompt: 'do the thing',
          repoId: REPO.id,
          harness: 'claude' as const,
          model: null,
          ravelRoster: [],
          verificationCommand: null,
          perRunTokenCeiling: null,
          concurrency: 'single-flight' as const,
          stopCondition: { kind: 'until-disabled' as const },
          approval: { createdBy: 'operator' as const, createdAt: 0, approvedAt: 0 }
        }
      ]
    }
    const res = await post('/api/command', {
      name: 'automation.upsert',
      operationId: 'op-1',
      payload: { definition }
    })
    expect(res.ok).toBe(true)

    const list = await post('/api/query', { name: 'automation.list' })
    expect(list).toHaveLength(1)
    expect(list[0].definition.id).toBe('auto-1')
    expect(list[0].currentRevision.id).toBe('rev-1')
  })

  it('projects a ravel-child worker detail with the right controls', async () => {
    const deps = makeDeps(dir, {
      listRavel: () => [ravelCfg()],
      getSession: (id) => (id === 'sess-1' ? childSession() : undefined)
    })
    await start(deps)
    const view = await post('/api/query', { name: 'worker.detail', workerId: 'sess-1' })
    expect(view.controlState).toMatchObject({ kind: 'ravel-child', lifecycle: 'running', hasParentRavel: true })
    // A live ravel-child offers message/pause/stop/detach, not retry/archive.
    expect(view.availableControls).toEqual(['message', 'pause', 'stop', 'detach'])
  })

  it('routes a worker.control message to the ravel runtime', async () => {
    const deps = makeDeps(dir, {
      listRavel: () => [ravelCfg()],
      getSession: (id) => (id === 'sess-1' ? childSession() : undefined)
    })
    await start(deps)
    const res = await post('/api/command', {
      name: 'worker.control',
      operationId: 'op-msg',
      payload: { workerId: 'sess-1', action: 'message', message: 'refocus on the parser' }
    })
    expect(res.ok).toBe(true)
    expect(deps.ravel.steerChild).toHaveBeenCalledWith('ravel-1', 'sess-1', 'refocus on the parser', expect.anything())
  })

  it('routes worker.control detach for a live ravel-child to the ravel runtime', async () => {
    const deps = makeDeps(dir, {
      listRavel: () => [ravelCfg()],
      getSession: (id) => (id === 'sess-1' ? childSession() : undefined)
    })
    await start(deps)
    const detach = await post('/api/command', {
      name: 'worker.control',
      operationId: 'op-detach',
      payload: { workerId: 'sess-1', action: 'detach', confirmed: true }
    })
    expect(detach.ok).toBe(true)
    expect(deps.ravel.detachChild).toHaveBeenCalledWith('ravel-1', 'sess-1', expect.anything())
  })

  it('routes worker.control archive for a terminal ravel-child to the ravel runtime', async () => {
    const done = dispatch({ status: 'completed' })
    const deps = makeDeps(dir, {
      listRavel: () => [ravelCfg({ dispatches: [done] })],
      getSession: (id) => (id === 'sess-1' ? childSession() : undefined)
    })
    await start(deps)
    const archive = await post('/api/command', {
      name: 'worker.control',
      operationId: 'op-archive',
      payload: { workerId: 'sess-1', action: 'archive', confirmed: true }
    })
    expect(archive.ok).toBe(true)
    expect(deps.ravel.archiveDispatch).toHaveBeenCalledWith('ravel-1', 'sess-1')
  })

  it('turns observed file activity into a queryable file-kind timeline event', async () => {
    const deps = makeDeps(dir, {
      getSession: (id) => (id === 'sess-1' ? childSession() : undefined)
    })
    await start(deps)

    core!.observeFileActivity([
      { id: 'act-1', sessionId: 'sess-1', path: 'src/parser.ts', kind: 'edited', ts: 777 }
    ])

    const after = await post('/api/query', { name: 'timeline.read', afterCursor: 0 })
    expect(after.events).toHaveLength(1)
    expect(after.events[0]).toMatchObject({
      kind: 'file',
      summary: 'edited src/parser.ts',
      workerKind: 'ravel-child',
      role: 'lead-engineer',
      timestamp: 777
    })
    expect(after.events[0].evidenceRefs).toEqual(['src/parser.ts'])
  })

  it('lands a review after its staleness rechecks pass, refusing a stale base', async () => {
    const changed = ['a.ts', 'b.ts']
    const digest = reviewDiffDigest({ baseCommit: 'base9', headCommit: 'head9', branch: 'ravel/brief-1', changedFiles: changed })
    const resolveCommit = vi.fn(async (_repo: string, rev?: string) => (rev === 'main' ? 'base9' : 'head9'))
    const merged = dispatch({ verification: { ok: true, output: 'pass' } })
    const deps = makeDeps(dir, {
      listRavel: () => [ravelCfg({ dispatches: [merged] })],
      git: {
        currentBranch: vi.fn(async () => 'main'),
        resolveCommit,
        changedFiles: vi.fn(async () => changed),
        mergeBranch: vi.fn(async () => ({
          ok: true,
          branch: 'ravel/brief-1',
          commit: 'landed01',
          alreadyMerged: false,
          files: changed,
          warning: null
        }) as MergeBranchResult),
        reviewFileList: vi.fn(async () => []),
        fileUnifiedDiff: vi.fn(async () => '')
      }
    })
    await start(deps)

    const ok = await post('/api/command', {
      name: 'review.decide',
      operationId: 'op-land',
      payload: {
        repoId: REPO.id,
        branch: 'ravel/brief-1',
        baseCommit: 'base9',
        headCommit: 'head9',
        diffDigest: digest,
        decision: 'land'
      }
    })
    expect(ok.ok).toBe(true)
    expect(deps.git.mergeBranch).toHaveBeenCalledWith(REPO.path, 'ravel/brief-1', 'main', { message: undefined })

    // A stale base (base moved) must be refused rather than merged.
    const stale = await post('/api/command', {
      name: 'review.decide',
      operationId: 'op-stale',
      payload: {
        repoId: REPO.id,
        branch: 'ravel/brief-1',
        baseCommit: 'OLDBASE',
        headCommit: 'head9',
        diffDigest: digest,
        decision: 'land'
      }
    })
    expect(stale.ok).toBe(false)
    expect(stale.error.message).toMatch(/stale base/)
  })

  it('lists reviewable branches with resolved commits and a matching digest', async () => {
    const files = ['a.ts', 'b.ts']
    const done = dispatch({ status: 'completed', branch: 'ravel/brief-1', verification: { ok: true, output: 'pass' } })
    await start(
      makeDeps(dir, {
        listRavel: () => [ravelCfg({ dispatches: [done] })],
        git: {
          currentBranch: vi.fn(async () => 'main'),
          resolveCommit: vi.fn(async (_repo: string, rev?: string) => (rev === 'main' ? 'base1' : 'head1')),
          changedFiles: vi.fn(async () => files),
          mergeBranch: vi.fn(async () => ({ ok: true, branch: 'ravel/brief-1', commit: 'x', alreadyMerged: false, files, warning: null }) as MergeBranchResult),
          reviewFileList: vi.fn(async () => []),
          fileUnifiedDiff: vi.fn(async () => '')
        }
      })
    )
    const list = await post('/api/query', { name: 'review.list' })
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      repoId: REPO.id,
      branch: 'ravel/brief-1',
      baseCommit: 'base1',
      headCommit: 'head1',
      changedFiles: files,
      verification: { ok: true, output: 'pass' },
      landable: true
    })
    const digest = reviewDiffDigest({ baseCommit: 'base1', headCommit: 'head1', branch: 'ravel/brief-1', changedFiles: files })
    expect(list[0].diffDigest).toBe(digest)
  })

  it('returns a bounded per-file diff with text, binary, rename, and oversized states', async () => {
    const metas = [
      { path: 'a.ts', oldPath: null, status: 'modified' as const, additions: 2, deletions: 1, binary: false },
      { path: 'logo.png', oldPath: null, status: 'added' as const, additions: null, deletions: null, binary: true },
      { path: 'new-name.ts', oldPath: 'old-name.ts', status: 'renamed' as const, additions: 0, deletions: 0, binary: false },
      { path: 'huge.ts', oldPath: null, status: 'added' as const, additions: 5000, deletions: 0, binary: false }
    ]
    const patches: Record<string, string> = {
      'a.ts': '@@ -1 +1 @@\n-old\n+new\n',
      'new-name.ts': 'rename from old-name.ts\nrename to new-name.ts\n',
      'huge.ts': 'x'.repeat(100_001)
    }
    await start(
      makeDeps(dir, {
        listRavel: () => [ravelCfg()],
        git: {
          currentBranch: vi.fn(async () => 'main'),
          resolveCommit: vi.fn(async (_repo: string, rev?: string) => (rev === 'main' ? 'base1' : 'head1')),
          changedFiles: vi.fn(async () => ['a.ts', 'logo.png', 'new-name.ts', 'huge.ts']),
          mergeBranch: vi.fn(async () => ({ ok: true, branch: 'b', commit: 'c', alreadyMerged: false, files: [], warning: null }) as MergeBranchResult),
          reviewFileList: vi.fn(async () => metas),
          fileUnifiedDiff: vi.fn(async (_rp: string, _b: string, _bb: string, path: string) => patches[path] ?? '')
        }
      })
    )
    const diff = await post('/api/query', { name: 'review.diff', repoId: REPO.id, branch: 'ravel/brief-1' })
    expect(diff).toMatchObject({ baseBranch: 'main', baseCommit: 'base1', headCommit: 'head1', truncated: false })
    const byPath = Object.fromEntries(diff.files.map((f: { path: string }) => [f.path, f]))
    expect(byPath['a.ts']).toMatchObject({ content: 'text', patch: patches['a.ts'], additions: 2, deletions: 1 })
    expect(byPath['logo.png']).toMatchObject({ content: 'binary', patch: '', additions: null, deletions: null })
    expect(byPath['new-name.ts']).toMatchObject({ status: 'renamed', oldPath: 'old-name.ts', content: 'text' })
    expect(byPath['huge.ts']).toMatchObject({ content: 'oversized', patch: '' })
    // The digest matches review.list's over the same file set, so a client can detect drift.
    expect(diff.diffDigest).toBe(
      reviewDiffDigest({ baseCommit: 'base1', headCommit: 'head1', branch: 'ravel/brief-1', changedFiles: ['a.ts', 'logo.png', 'new-name.ts', 'huge.ts'] })
    )
  })

  it('marks files past the per-review byte budget as truncated', async () => {
    const big = 'y'.repeat(90_000)
    const paths = ['f0.ts', 'f1.ts', 'f2.ts', 'f3.ts', 'f4.ts', 'f5.ts']
    const metas = paths.map((p) => ({ path: p, oldPath: null, status: 'modified' as const, additions: 1, deletions: 0, binary: false }))
    await start(
      makeDeps(dir, {
        listRavel: () => [ravelCfg()],
        git: {
          currentBranch: vi.fn(async () => 'main'),
          resolveCommit: vi.fn(async () => 'sha'),
          changedFiles: vi.fn(async () => paths),
          mergeBranch: vi.fn(async () => ({ ok: true, branch: 'b', commit: 'c', alreadyMerged: false, files: [], warning: null }) as MergeBranchResult),
          reviewFileList: vi.fn(async () => metas),
          fileUnifiedDiff: vi.fn(async () => big)
        }
      })
    )
    const diff = await post('/api/query', { name: 'review.diff', repoId: REPO.id, branch: 'ravel/brief-1' })
    expect(diff.truncated).toBe(true)
    const contents = diff.files.map((f: { content: string }) => f.content)
    expect(contents.filter((c: string) => c === 'text').length).toBeGreaterThan(0)
    expect(contents).toContain('truncated')
    // A truncated file keeps its metadata but drops the patch bytes.
    const truncatedFile = diff.files.find((f: { content: string }) => f.content === 'truncated')
    expect(truncatedFile).toMatchObject({ patch: '', additions: 1 })
  })
})
