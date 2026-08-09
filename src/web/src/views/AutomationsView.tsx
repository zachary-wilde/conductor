// Automations screen. Lists `automation.list`, shows each definition's current
// revision + recent occurrences, and wires the three operator commands an
// existing automation needs: toggle enable, approve a revision, and (stretch)
// create a new definition via `automation.upsert`.

import { useCallback, useEffect, useState } from 'react'
import { Plus, RotateCw } from 'lucide-react'
import type { AutomationDefinition, AutomationRevision } from '@ops/types'
import type { AutomationListItem, ClientCommand } from '@ops/api-contract'
import {
  automationApprove,
  automationSetEnabled,
  automationUpsert,
  newOperationId
} from '../viewmodel/commands'
import { useCore } from '../state/coreContext'
import { formatClock } from '../viewmodel/events'
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Notice,
  Spinner,
  TextArea,
  TextInput,
  Toggle
} from '../components/ui'

const OCCURRENCE_TONE: Record<string, string> = {
  succeeded: 'bg-accent-green/15 text-accent-green',
  failed: 'bg-[rgb(var(--danger))]/15 text-[rgb(var(--danger))]',
  interrupted: 'bg-[rgb(var(--warn))]/15 text-[rgb(var(--warn))]',
  skipped: 'bg-bg-3 text-text-hint',
  running: 'bg-accent-blue/15 text-accent-blue',
  claimed: 'bg-accent/15 text-accent',
  due: 'bg-bg-3 text-text-mid'
}

export function AutomationsView(): JSX.Element {
  const { client, compatible } = useCore()
  const [items, setItems] = useState<AutomationListItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<{ tone: 'info' | 'error'; text: string } | null>(null)
  const [showForm, setShowForm] = useState(false)

  const load = useCallback(() => {
    setError(null)
    client
      .query({ name: 'automation.list' })
      .then((list) => setItems(list))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [client])

  useEffect(() => load(), [load])

  async function mutate(
    automationId: string,
    build: () => ClientCommand
  ): Promise<void> {
    if (!compatible) return
    setBusyId(automationId)
    setFeedback(null)
    try {
      const res = await client.command(build())
      setFeedback(
        res.ok
          ? { tone: 'info', text: 'Done.' }
          : { tone: 'error', text: `Refused: ${res.error?.message ?? res.error?.code ?? 'unknown'}` }
      )
      if (res.ok) load()
    } catch (e: unknown) {
      setFeedback({ tone: 'error', text: `Failed: ${e instanceof Error ? e.message : String(e)}` })
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <h1 className="text-sm font-semibold text-text-hi">Automations</h1>
        <Button variant="ghost" className="ml-auto px-2 py-1" onClick={load}>
          <RotateCw size={13} /> refresh
        </Button>
        <Button
          variant="primary"
          className="px-2 py-1"
          disabled={!compatible}
          onClick={() => setShowForm((s) => !s)}
        >
          <Plus size={13} /> new
        </Button>
      </div>

      {!compatible ? (
        <Notice tone="warn">Incompatible core — automation commands are read-only.</Notice>
      ) : null}

      {feedback ? <Notice tone={feedback.tone === 'error' ? 'error' : 'info'}>{feedback.text}</Notice> : null}

      {showForm ? (
        <NewAutomationForm
          disabled={!compatible}
          onCancel={() => setShowForm(false)}
          onSubmit={async (def) => {
            setBusyId('__new')
            setFeedback(null)
            try {
              const res = await client.command(automationUpsert(def))
              if (res.ok) {
                setShowForm(false)
                setFeedback({ tone: 'info', text: 'Automation created.' })
                load()
              } else {
                setFeedback({
                  tone: 'error',
                  text: `Create refused: ${res.error?.message ?? res.error?.code ?? 'unknown'}`
                })
              }
            } catch (e: unknown) {
              setFeedback({ tone: 'error', text: `Create failed: ${e instanceof Error ? e.message : String(e)}` })
            } finally {
              setBusyId(null)
            }
          }}
          busy={busyId === '__new'}
        />
      ) : null}

      {error ? (
        <Notice tone="error">
          Could not load automations: {error}
          <button onClick={load} className="ml-2 underline">retry</button>
        </Notice>
      ) : null}

      {items !== null && items.length === 0 ? (
        <EmptyState title="No automations" body="Define a schedule to wake a session or launch a Ravel on a cron." />
      ) : null}

      {items?.map((item) => (
        <AutomationCard
          key={item.definition.id}
          item={item}
          disabled={!compatible}
          busy={busyId === item.definition.id}
          onToggle={(enabled) => mutate(item.definition.id, () => automationSetEnabled(item.definition.id, enabled))}
          onApprove={() =>
            mutate(item.definition.id, () =>
              automationApprove(item.definition.id, item.currentRevision.id)
            )
          }
        />
      ))}
    </div>
  )
}

function AutomationCard({
  item,
  disabled,
  busy,
  onToggle,
  onApprove
}: {
  item: AutomationListItem
  disabled: boolean
  busy: boolean
  onToggle: (enabled: boolean) => void
  onApprove: () => void
}): JSX.Element {
  const rev = item.currentRevision
  const approved = rev.approval.approvedAt !== null
  return (
    <article className="flex flex-col gap-2 rounded-lg border border-edge bg-bg-1 p-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-sm font-medium text-text-hi">{rev.title || item.definition.id}</h2>
            <Badge className="bg-bg-3 text-text-mid">{rev.kind}</Badge>
            {approved ? (
              <Badge className="bg-accent-green/15 text-accent-green">approved</Badge>
            ) : (
              <Badge className="bg-[rgb(var(--warn))]/15 text-[rgb(var(--warn))]">pending</Badge>
            )}
          </div>
          <p className="mt-0.5 truncate font-mono text-[10px] text-text-hint">{item.definition.id}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="font-mono text-[10px] text-text-low">{rev.enabled ? 'on' : 'off'}</span>
          <Toggle checked={rev.enabled} disabled={disabled || busy} onChange={onToggle} label="enabled" />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[10px] text-text-low">
        <span>{rev.cadence.expression}</span>
        <span className="text-text-hint">{rev.cadence.timezone}</span>
        {rev.repoId ? <span>· {rev.repoId}</span> : null}
        {rev.model ? <span>· {rev.model}</span> : null}
      </div>

      {rev.prompt ? (
        <p className="selectable line-clamp-2 rounded bg-bg-0 px-2 py-1.5 text-xs text-text-mid">
          {rev.prompt}
        </p>
      ) : null}

      {!approved ? (
        <div className="flex items-center gap-2">
          <Button variant="success" disabled={disabled || busy} onClick={onApprove}>
            {busy ? <Spinner /> : null}
            Approve revision
          </Button>
          <span className="text-[10px] text-text-hint">
            created by {rev.approval.createdBy}; runs only after operator approval
          </span>
        </div>
      ) : null}

      {item.recentOccurrences.length > 0 ? (
        <div className="mt-1 flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wide text-text-hint">Recent runs</span>
          <div className="flex flex-col gap-0.5">
            {item.recentOccurrences.slice(-6).map((occ) => (
              <div key={occ.id} className="flex items-center gap-2 font-mono text-[10px] text-text-low">
                <Badge className={OCCURRENCE_TONE[occ.state] ?? 'bg-bg-3 text-text-mid'}>{occ.state}</Badge>
                <span>{formatClock(occ.scheduledAt)}</span>
                {occ.missedCount > 0 ? <span className="text-text-hint">· {occ.missedCount} coalesced</span> : null}
                {occ.failure ? (
                  <span className="truncate text-[rgb(var(--danger))]">· {occ.failure.reason}</span>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </article>
  )
}

function NewAutomationForm({
  disabled,
  busy,
  onSubmit,
  onCancel
}: {
  disabled: boolean
  busy: boolean
  onSubmit: (def: AutomationDefinition) => void
  onCancel: () => void
}): JSX.Element {
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [repoId, setRepoId] = useState('')
  const [expression, setExpression] = useState('*/15 * * * *')
  const [timezone, setTimezone] = useState('UTC')
  const [kind, setKind] = useState<AutomationRevision['kind']>('schedule')

  const valid = title.trim().length > 0 && prompt.trim().length > 0 && repoId.trim().length > 0

  function build(): AutomationDefinition {
    const revisionId = newOperationId()
    const revision: AutomationRevision = {
      id: revisionId,
      kind,
      title: title.trim(),
      enabled: true,
      cadence: { expression: expression.trim(), timezone: timezone.trim() || 'UTC' },
      targetId: null,
      prompt: prompt.trim(),
      repoId: repoId.trim(),
      harness: null,
      model: null,
      ravelRoster: [],
      verificationCommand: null,
      perRunTokenCeiling: null,
      concurrency: 'single-flight',
      stopCondition: { kind: 'until-disabled' },
      approval: { createdBy: 'operator', createdAt: Date.now(), approvedAt: Date.now() }
    }
    return {
      id: `auto-${newOperationId()}`,
      currentRevisionId: revisionId,
      revisions: [revision]
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (!valid) return
        onSubmit(build())
      }}
      className="flex flex-col gap-3 rounded-lg border border-edge bg-bg-1 p-3"
    >
      <h2 className="text-xs font-semibold uppercase tracking-wide text-text-low">New automation</h2>
      <Field label="Title">
        <TextInput value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Nightly dependency sweep" />
      </Field>
      <Field label="Prompt">
        <TextArea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="What the target should do each run" />
      </Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Repo id">
          <TextInput value={repoId} onChange={(e) => setRepoId(e.target.value)} placeholder="my-repo" />
        </Field>
        <Field label="Kind">
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as AutomationRevision['kind'])}
            className="rounded-md border border-edge bg-bg-1 px-3 py-2 text-sm text-text-hi focus:border-accent focus:outline-none"
          >
            <option value="schedule">schedule</option>
            <option value="heartbeat">heartbeat</option>
          </select>
        </Field>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Cron (5-field)" hint="minute hour day month weekday">
          <TextInput
            className="font-mono"
            value={expression}
            onChange={(e) => setExpression(e.target.value)}
          />
        </Field>
        <Field label="Timezone" hint="IANA id, e.g. America/Toronto">
          <TextInput value={timezone} onChange={(e) => setTimezone(e.target.value)} />
        </Field>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="primary" type="submit" disabled={disabled || busy || !valid}>
          {busy ? <Spinner /> : <Plus size={14} />}
          Create
        </Button>
        <Button variant="ghost" type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
