// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { WorkerDetailView } from '@ops/api-contract'
import { DetailsSheet } from './DetailsSheet'

Object.assign(globalThis, { React })

afterEach(() => cleanup())

const detail: WorkerDetailView = {
  workerId: 'worker-api-7',
  controlState: {
    kind: 'ravel-child',
    lifecycle: 'paused',
    responseInFlight: false,
    hasParentRavel: true,
    dependentCount: 1
  },
  availableControls: ['message', 'resume', 'stop', 'detach'],
  latestEvents: [
    {
      id: 'event-1',
      cursor: 1,
      timestamp: 1_700_000_000_000,
      repoId: null,
      rootWorkflowId: 'ravel-1',
      rootWorkflowKind: 'ravel',
      parentWorkerId: 'worker-api-7',
      workerId: 'worker-api-7',
      workerKind: 'ravel-child',
      role: null,
      harness: null,
      model: null,
      attempt: 1,
      kind: 'verification',
      summary: 'API event summary',
      evidenceRefs: [],
      source: {}
    }
  ],
  dependentBriefs: ['API dependent brief']
}

test('keeps the details sheet hidden by default', () => {
  const onClose = vi.fn()
  render(
    <DetailsSheet
      open={false}
      onClose={onClose}
      worker={detail}
      events={detail.latestEvents}
      controls={detail.availableControls}
      readOnly={false}
    />
  )

  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.queryByText('API event summary')).not.toBeInTheDocument()
})

test('renders API-backed identity, controls, event, and dependent brief data when open', () => {
  render(
    <DetailsSheet
      open
      onClose={vi.fn()}
      worker={detail}
      events={detail.latestEvents}
      controls={detail.availableControls}
      readOnly={false}
    />
  )

  const dialog = screen.getByRole('dialog', { name: 'Worker details' })
  expect(dialog).toHaveTextContent('worker-api-7')
  expect(dialog).toHaveTextContent('paused')
  expect(dialog).toHaveTextContent('resume')
  expect(dialog).toHaveTextContent('API event summary')
  expect(dialog).toHaveTextContent('API dependent brief')
  expect(dialog).not.toHaveTextContent('parent ravel')
  expect(dialog).not.toHaveTextContent('branch')
  expect(dialog).not.toHaveTextContent('worktree')
  expect(dialog).not.toHaveTextContent('file')
})

test('closes from its accessible button and Escape, restoring focus to the opener', () => {
  const onClose = vi.fn()
  const opener = document.createElement('button')
  opener.type = 'button'
  opener.textContent = 'Details'
  document.body.append(opener)
  opener.focus()
  const { rerender } = render(
    <DetailsSheet
      open
      onClose={onClose}
      worker={detail}
      events={detail.latestEvents}
      controls={detail.availableControls}
      readOnly={false}
      restoreFocusRef={{ current: opener }}
    />
  )

  fireEvent.click(screen.getByRole('button', { name: 'Close worker details' }))
  expect(onClose).toHaveBeenCalledTimes(1)
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(onClose).toHaveBeenCalledTimes(2)

  rerender(
    <DetailsSheet
      open={false}
      onClose={onClose}
      worker={detail}
      events={detail.latestEvents}
      controls={detail.availableControls}
      readOnly={false}
      restoreFocusRef={{ current: opener }}
    />
  )
  expect(opener).toHaveFocus()
})

test('restores focus when the owning view unmounts the open sheet', () => {
  const opener = document.createElement('button')
  opener.type = 'button'
  document.body.append(opener)
  opener.focus()
  const { unmount } = render(
    <DetailsSheet
      open
      onClose={vi.fn()}
      worker={detail}
      events={detail.latestEvents}
      controls={detail.availableControls}
      readOnly={false}
      restoreFocusRef={{ current: opener }}
    />
  )

  expect(screen.getByRole('button', { name: 'Close worker details' })).toHaveFocus()
  unmount()
  expect(opener).toHaveFocus()
})
