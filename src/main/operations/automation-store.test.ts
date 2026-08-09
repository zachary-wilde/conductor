import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAutomationStore } from './automation-store'
import type { AutomationDefinition, AutomationRevision, Occurrence } from './types'

// Fixed epoch constants — never Date.now(). All times here are arbitrary ms.
const T0 = 1_700_000_000_000
const T1 = T0 + 60_000
const T2 = T0 + 120_000

const revision = (over: Partial<AutomationRevision> = {}): AutomationRevision => ({
  id: 'rev-1',
  kind: 'heartbeat',
  title: 'Nightly check',
  enabled: true,
  cadence: { expression: '0 2 * * *', timezone: 'America/Toronto' },
  targetId: 'ravel-1',
  prompt: 'do the thing',
  repoId: 'repo-1',
  harness: 'claude',
  model: 'opus',
  ravelRoster: [],
  verificationCommand: null,
  perRunTokenCeiling: 10_000,
  concurrency: 'single-flight',
  stopCondition: { kind: 'until-disabled' },
  approval: { createdBy: 'operator', createdAt: T0, approvedAt: T0 },
  ...over
})

const definition = (over: Partial<AutomationDefinition> = {}): AutomationDefinition => ({
  id: 'auto-1',
  currentRevisionId: 'rev-1',
  revisions: [revision()],
  ...over
})

const occurrence = (over: Partial<Occurrence> = {}): Occurrence => ({
  id: 'occ-1',
  automationId: 'auto-1',
  revisionId: 'rev-1',
  state: 'due',
  scheduledAt: T0,
  startedAt: null,
  endedAt: null,
  isCatchUp: false,
  missedCount: 0,
  runId: null,
  operationId: 'op-1',
  failure: null,
  tokensUsed: null,
  ...over
})

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'automation-store-'))
  file = join(dir, 'store.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('createAutomationStore — initialization', () => {
  it('initializes an empty store when the file is missing and persists it', () => {
    const store = createAutomationStore(file)

    expect(store.listDefinitions()).toEqual([])
    expect(store.listOccurrences()).toEqual([])
    expect(store.getLoadError()).toBeNull()
    // The missing file was created with an empty, well-formed shape.
    expect(existsSync(file)).toBe(true)
    const onDisk = JSON.parse(readFileSync(file, 'utf8'))
    expect(onDisk).toEqual({ version: 1, definitions: [], occurrences: [] })
  })

  it('accepts a lazy path resolver, not just a string', () => {
    const store = createAutomationStore(() => file)
    store.putDefinition(definition())
    expect(store.getDefinition('auto-1')).not.toBeNull()
  })
})

describe('definitions', () => {
  it('round-trips definitions through a reopened store', () => {
    const store = createAutomationStore(file)
    store.putDefinition(definition({ id: 'auto-1' }))
    store.putDefinition(definition({ id: 'auto-2', currentRevisionId: 'rev-x' }))

    // A second store on the same file must see what the first persisted.
    const reopened = createAutomationStore(file)
    const defs = reopened.listDefinitions()
    expect(defs.map((d) => d.id).sort()).toEqual(['auto-1', 'auto-2'])

    const got = reopened.getDefinition('auto-2')
    expect(got).toEqual(definition({ id: 'auto-2', currentRevisionId: 'rev-x' }))
    expect(reopened.getDefinition('does-not-exist')).toBeNull()
  })

  it('putDefinition replaces a whole definition by id', () => {
    const store = createAutomationStore(file)
    store.putDefinition(
      definition({ id: 'auto-1', currentRevisionId: 'rev-1', revisions: [revision({ id: 'rev-1' })] })
    )
    // Re-put the same id with entirely new contents.
    store.putDefinition(
      definition({
        id: 'auto-1',
        currentRevisionId: 'rev-2',
        revisions: [revision({ id: 'rev-1' }), revision({ id: 'rev-2', title: 'New plan' })]
      })
    )

    expect(store.listDefinitions()).toHaveLength(1)
    const got = store.getDefinition('auto-1')
    expect(got?.currentRevisionId).toBe('rev-2')
    expect(got?.revisions.map((r) => r.id)).toEqual(['rev-1', 'rev-2'])
  })
})

describe('revisions', () => {
  it('addRevision appends without changing currentRevisionId', () => {
    const store = createAutomationStore(file)
    store.putDefinition(
      definition({
        id: 'auto-1',
        currentRevisionId: 'rev-1',
        revisions: [revision({ id: 'rev-1' })]
      })
    )

    store.addRevision('auto-1', revision({ id: 'rev-2', title: 'Second draft' }))

    const got = store.getDefinition('auto-1')
    expect(got?.revisions.map((r) => r.id)).toEqual(['rev-1', 'rev-2'])
    // currentRevisionId is deliberately untouched until approval.
    expect(got?.currentRevisionId).toBe('rev-1')
  })

  it('addRevision throws for an unknown automation', () => {
    const store = createAutomationStore(file)
    expect(() => store.addRevision('ghost', revision())).toThrow(/unknown automation/)
  })

  it('setCurrentRevision points at an existing revision', () => {
    const store = createAutomationStore(file)
    store.putDefinition(
      definition({
        id: 'auto-1',
        currentRevisionId: 'rev-1',
        revisions: [revision({ id: 'rev-1' }), revision({ id: 'rev-2' })]
      })
    )

    store.setCurrentRevision('auto-1', 'rev-2')

    expect(store.getDefinition('auto-1')?.currentRevisionId).toBe('rev-2')
  })

  it('setCurrentRevision throws on unknown revision id', () => {
    const store = createAutomationStore(file)
    store.putDefinition(
      definition({ id: 'auto-1', revisions: [revision({ id: 'rev-1' })] })
    )

    expect(() => store.setCurrentRevision('auto-1', 'nope')).toThrow(/unknown revision/)
  })

  it('setCurrentRevision throws for an unknown automation', () => {
    const store = createAutomationStore(file)
    expect(() => store.setCurrentRevision('ghost', 'rev-1')).toThrow(/unknown automation/)
  })
})

describe('occurrences', () => {
  it('upserts occurrences by id and survives reopen', () => {
    const store = createAutomationStore(file)
    store.putOccurrence(occurrence({ id: 'occ-1', state: 'due' }))
    // Same id, different state — must replace, not append.
    store.putOccurrence(occurrence({ id: 'occ-1', state: 'running', startedAt: T1 }))

    expect(store.listOccurrences()).toHaveLength(1)
    expect(store.getOccurrence('occ-1')?.state).toBe('running')

    const reopened = createAutomationStore(file)
    expect(reopened.getOccurrence('occ-1')?.state).toBe('running')
    expect(reopened.getOccurrence('missing')).toBeNull()
  })

  it('listOccurrences returns all and filters by automation', () => {
    const store = createAutomationStore(file)
    store.putOccurrence(occurrence({ id: 'a', automationId: 'auto-1' }))
    store.putOccurrence(occurrence({ id: 'b', automationId: 'auto-1' }))
    store.putOccurrence(occurrence({ id: 'c', automationId: 'auto-2' }))

    expect(store.listOccurrences()).toHaveLength(3)
    expect(store.listOccurrences('auto-1').map((o) => o.id).sort()).toEqual(['a', 'b'])
    expect(store.listOccurrences('auto-2').map((o) => o.id)).toEqual(['c'])
    expect(store.listOccurrences('auto-3')).toEqual([])
  })
})

describe('getters return copies', () => {
  it('mutating a returned definition does not change stored state', () => {
    const store = createAutomationStore(file)
    store.putDefinition(definition({ id: 'auto-1' }))

    const got = store.getDefinition('auto-1')!
    got.currentRevisionId = 'tampered'
    got.revisions[0].title = 'tampered'
    got.revisions.push(revision({ id: 'evil' }))

    const fresh = store.getDefinition('auto-1')!
    expect(fresh.currentRevisionId).toBe('rev-1')
    expect(fresh.revisions[0].title).toBe('Nightly check')
    expect(fresh.revisions).toHaveLength(1)
  })

  it('mutating a returned occurrence does not change stored state', () => {
    const store = createAutomationStore(file)
    store.putOccurrence(occurrence({ id: 'occ-1' }))

    const got = store.getOccurrence('occ-1')!
    got.state = 'succeeded'
    got.tokensUsed = 9999
    got.failure = { reason: 'sabotage' }

    const fresh = store.getOccurrence('occ-1')!
    expect(fresh.state).toBe('due')
    expect(fresh.tokensUsed).toBeNull()
    expect(fresh.failure).toBeNull()
  })

  it('mutating a listDefinitions result does not change stored state', () => {
    const store = createAutomationStore(file)
    store.putDefinition(definition({ id: 'auto-1' }))

    const list = store.listDefinitions()
    list[0].id = 'mutated'
    list.push(definition({ id: 'injected' }))

    expect(store.listDefinitions().map((d) => d.id)).toEqual(['auto-1'])
  })

  it('mutating a listOccurrences result does not change stored state', () => {
    const store = createAutomationStore(file)
    store.putOccurrence(occurrence({ id: 'occ-1' }))

    const list = store.listOccurrences()
    list[0].state = 'failed'
    list.pop()

    expect(store.listOccurrences()).toHaveLength(1)
    expect(store.getOccurrence('occ-1')?.state).toBe('due')
  })
})

describe('durability — corrupt and unparseable files', () => {
  it('does not overwrite an unparseable file; surfaces the error', () => {
    writeFileSync(file, '{not valid json')

    const store = createAutomationStore(file)
    expect(() => store.listDefinitions()).toThrow(/failed to load automation store/)
    expect(store.getLoadError()).not.toBeNull()

    // The corrupt file must be byte-for-byte untouched.
    expect(readFileSync(file, 'utf8')).toBe('{not valid json')
  })

  it('does not overwrite a malformed-but-parseable file', () => {
    writeFileSync(file, JSON.stringify({ definitions: 'not-an-array', occurrences: [] }))

    const store = createAutomationStore(file)
    expect(() => store.listDefinitions()).toThrow(/failed to load automation store/)
    expect(readFileSync(file, 'utf8')).toBe(
      JSON.stringify({ definitions: 'not-an-array', occurrences: [] })
    )
  })

  it('a later valid write still works after a corrupt load', () => {
    writeFileSync(file, '{not valid json')

    const store = createAutomationStore(file)
    expect(() => store.listDefinitions()).toThrow()
    expect(readFileSync(file, 'utf8')).toBe('{not valid json')

    // A deliberate write replaces the unrecoverable file with valid data.
    store.putDefinition(definition({ id: 'auto-1' }))
    expect(store.getLoadError()).toBeNull()
    expect(store.getDefinition('auto-1')).not.toBeNull()

    // The file is now valid JSON, and a fresh store reads it cleanly.
    expect(() => JSON.parse(readFileSync(file, 'utf8'))).not.toThrow()
    const reopened = createAutomationStore(file)
    expect(reopened.getDefinition('auto-1')?.id).toBe('auto-1')
    expect(reopened.getLoadError()).toBeNull()
  })

  it('occurrence write also recovers the store after a corrupt load', () => {
    writeFileSync(file, ',,,garbage')

    const store = createAutomationStore(file)
    expect(() => store.listOccurrences()).toThrow()

    store.putOccurrence(occurrence({ id: 'occ-1' }))
    expect(store.getOccurrence('occ-1')?.id).toBe('occ-1')
    expect(store.getLoadError()).toBeNull()
  })
})

describe('persistence through reopen', () => {
  it('keeps revisions, occurrences, and current pointer across reopen', () => {
    const store = createAutomationStore(file)
    store.putDefinition(
      definition({
        id: 'auto-1',
        currentRevisionId: 'rev-1',
        revisions: [revision({ id: 'rev-1' })]
      })
    )
    store.addRevision('auto-1', revision({ id: 'rev-2', approval: { createdBy: 'agent', createdAt: T1, approvedAt: null } }))
    store.setCurrentRevision('auto-1', 'rev-2')
    store.putOccurrence(occurrence({ id: 'occ-1', scheduledAt: T2, missedCount: 3 }))

    const reopened = createAutomationStore(file)
    const def = reopened.getDefinition('auto-1')!
    expect(def.currentRevisionId).toBe('rev-2')
    expect(def.revisions.map((r) => r.id)).toEqual(['rev-1', 'rev-2'])
    expect(reopened.getOccurrence('occ-1')).toEqual(
      occurrence({ id: 'occ-1', scheduledAt: T2, missedCount: 3 })
    )
  })
})
