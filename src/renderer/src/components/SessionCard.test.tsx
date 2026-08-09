// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { PublicRavelConfig, Session } from '@shared/types'
import { installApi, resetStore, ravelFixture } from '../lib/testStubs'
import { useStore } from '../store/useStore'
import { DocumentWorkspaceProvider } from './DocumentWorkspace'
import { SessionCard } from './SessionCard'

Object.assign(globalThis, { React })

const session: Session = {
  id: 'session-1',
  repoId: 'repo-1',
  repoPath: 'D:/repo',
  worktreePath: 'D:/repo/.worktrees/lead',
  branch: 'feature/rail',
  status: 'needs-input',
  title: 'Do not render this name',
  initialPrompt: null,
  createdAt: 1,
  lastActivityAt: 2,
  kind: 'ravel-child',
  harness: 'claude',
  parentId: null,
  ravelId: 'ravel-1',
  ravelRole: 'lead-engineer',
  briefId: 'brief-1'
}

const ravel: PublicRavelConfig = ravelFixture({
  plan: {
    revision: 1,
    createdAt: 1,
    sourceMessageIds: [],
    mission: { goal: '', context: [], constraints: [], acceptanceCriteria: [], assumptions: [] },
    orientation: '',
    briefs: [
      {
        id: 'brief-1',
        title: 'Lead',
        role: 'lead-engineer',
        harness: 'claude',
        model: 'opus',
        phase: 'implementation',
        goal: '',
        relevantContext: [],
        constraints: [],
        acceptanceCriteria: [],
        doNotTouch: [],
        expectedOutput: '',
        escalationConditions: [],
        dependsOn: [],
        contextExceptionReason: null
      }
    ],
    approvedAt: null,
    approvedRevision: null
  },
  dispatches: [
    {
      briefId: 'brief-1',
      planRevision: 1,
      sessionId: 'session-1',
      branch: 'feature/rail',
      worktreePath: 'D:/repo/.worktrees/lead',
      status: 'active',
      startedAt: 1,
      endedAt: null,
      baseCommit: null,
      usage: { inputTokens: 1000, outputTokens: 234, costUsd: 0.12 },
      report: null,
      contextRequests: 0,
      verification: null
    }
  ]
})

function renderCard(): void {
  render(
    <DocumentWorkspaceProvider>
      <SessionCard session={session} />
    </DocumentWorkspaceProvider>
  )
}

beforeEach(() => {
  installApi()
  resetStore({ sessions: [session], ravelList: [ravel] })
})

afterEach(cleanup)

describe('SessionCard', () => {
  test('uses model and role identity without rendering the session name', () => {
    renderCard()

    expect(screen.getByText('opus · Lead Engineer')).toBeInTheDocument()
    expect(screen.queryByText('Do not render this name')).toBeNull()
    expect(screen.getByText('feature/rail')).toBeInTheDocument()
    expect(screen.getByText('~$0.12')).toBeInTheDocument()
    expect(screen.getByText(/1\.2k tok est\./)).toBeInTheDocument()
  })

  test('maps status to the shared activity badge', () => {
    renderCard()

    expect(screen.getByTestId('activity-needs-input')).toBeInTheDocument()
    expect(screen.getByText('Held up')).toBeInTheDocument()
  })

  test('opens the session when clicked', async () => {
    renderCard()

    await userEvent.click(screen.getByTestId('session-card'))

    expect(useStore.getState().view).toBe('session')
    expect(useStore.getState().selectedSessionId).toBe('session-1')
  })
})
