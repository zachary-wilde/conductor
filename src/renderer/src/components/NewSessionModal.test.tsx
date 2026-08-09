// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import React from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DEFAULT_SETTINGS, HARNESS_INFO, type Repo } from '@shared/types'
import { NewSessionModal, slugBranchLabel } from './NewSessionModal'
import { roundtableFixture, installApi, resetStore } from '../lib/testStubs'

Object.assign(globalThis, { React })

const repo: Repo = { id: 'repo-1', name: 'Repo', path: 'D:/repo', addedAt: 1 }

function installLauncherApi(overrides: Partial<Window['api']> = {}): void {
  installApi({
    currentBranch: vi.fn().mockResolvedValue('main'),
    ...overrides
  })
}

function resetLauncherStore(): void {
  resetStore({
    repos: [repo],
    showNewSession: true,
    settings: { ...structuredClone(DEFAULT_SETTINGS), defaultHarness: 'codex' },
    harnesses: [
      { id: 'claude', available: true, info: HARNESS_INFO.claude },
      { id: 'codex', available: true, info: HARNESS_INFO.codex }
    ]
  })
}

describe('NewSessionModal launcher', () => {
  beforeEach(() => {
    installLauncherApi()
    resetLauncherStore()
  })

  afterEach(() => cleanup())

  test('slugifies free-form branch labels into a valid ref segment', () => {
    expect(slugBranchLabel('what is a feat')).toBe('what-is-a-feat')
    expect(slugBranchLabel('  Feat/~ odd^:?*[\\ name..  ')).toBe('feat-odd-name')
    expect(slugBranchLabel('...')).toBe('session')
  })

  test('creates a model and role session without asking for a name', async () => {
    const createSession = vi.fn().mockResolvedValue({
      id: 'session-1',
      repoId: repo.id,
      repoPath: repo.path,
      worktreePath: repo.path,
      branch: 'main',
      harness: 'codex',
      title: null,
      initialPrompt: null,
      status: 'running',
      createdAt: 1,
      lastActivityAt: 1,
      kind: 'normal',
      parentId: null,
      ravelId: null,
      ravelRole: null,
      briefId: null
    })
    installLauncherApi({ createSession })
    const user = userEvent.setup()

    render(<NewSessionModal />)

    expect(screen.getByRole('tab', { name: 'Session' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Debate' })).toBeInTheDocument()
    expect(screen.queryByLabelText(/^Name/)).toBeNull()
    expect(screen.queryByLabelText('Repository')).toBeNull()
    expect(screen.queryByLabelText('New branch')).toBeNull()
    expect(screen.queryByLabelText('Reasoning')).toBeNull()
    expect(screen.queryByLabelText('Initial prompt')).toBeNull()

    await user.selectOptions(screen.getByLabelText('Model'), 'gpt-5.5')
    await user.selectOptions(screen.getByLabelText('Role preset'), 'lead-engineer')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Launch session' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Launch session' }))

    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1))
    const request = createSession.mock.calls[0][0]
    expect(request).toMatchObject({
      repoId: repo.id,
      repoPath: repo.path,
      worktreePath: '',
      harness: 'codex',
      model: 'gpt-5.5',
      initialPrompt: expect.stringContaining('ROLE: Lead Engineer'),
      createWorktree: {
        repoPath: repo.path,
        baseBranch: 'main',
        newBranch: true
      }
    })
    expect(request.branch).toMatch(/^conductor\/lead-engineer-gpt-5-5-[0-9a-f]{6}$/)
    expect(request.createWorktree.branch).toBe(request.branch)
    expect(request).not.toHaveProperty('title')
    expect(window.api.listBranches).not.toHaveBeenCalled()
    expect(window.api.listWorktrees).not.toHaveBeenCalled()
  })

  test('creates and immediately starts a two-seat debate', async () => {
    const created = roundtableFixture({ id: 'debate-1', name: 'Choose the launch strategy', maxTurns: 4 })
    const createRoundtable = vi.fn().mockResolvedValue({ ok: true, roundtable: created })
    const startRoundtable = vi.fn().mockResolvedValue({ ok: true, roundtable: { ...created, status: 'running' } })
    installLauncherApi({ createRoundtable, startRoundtable })
    const user = userEvent.setup()

    render(<NewSessionModal />)
    await user.click(screen.getByRole('tab', { name: 'Debate' }))

    expect(screen.queryByLabelText(/^Name/)).toBeNull()
    await user.type(screen.getByLabelText('Topic'), 'Choose the launch strategy')
    await user.selectOptions(screen.getByLabelText('Seat 1 model'), 'gpt-5.5')
    await user.type(screen.getByLabelText('Seat 1 stance'), 'Prefer the smallest reversible change.')
    await user.selectOptions(screen.getByLabelText('Seat 2 harness'), 'claude')
    await user.selectOptions(screen.getByLabelText('Seat 2 model'), 'opus')
    await user.type(screen.getByLabelText('Seat 2 stance'), 'Challenge hidden migration risk.')

    expect(screen.getByLabelText('Max turns')).toHaveValue('4')
    await user.click(screen.getByRole('button', { name: 'Start debate' }))

    await waitFor(() => expect(createRoundtable).toHaveBeenCalledTimes(1))
    const request = createRoundtable.mock.calls[0][0]
    expect(request).toMatchObject({
      name: 'Choose the launch strategy',
      repoId: repo.id,
      repoPath: repo.path,
      topic: 'Choose the launch strategy',
      maxTurns: 4,
      seats: [
        {
          name: 'Advocate',
          harness: 'codex',
          model: 'gpt-5.5',
          stance: 'Prefer the smallest reversible change.'
        },
        {
          name: 'Sceptic',
          harness: 'claude',
          model: 'opus',
          stance: 'Challenge hidden migration risk.'
        }
      ]
    })
    await waitFor(() => expect(startRoundtable).toHaveBeenCalledWith('debate-1'))
  })
})
