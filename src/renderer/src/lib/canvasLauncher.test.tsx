// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import React from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DEFAULT_SETTINGS, HARNESS_INFO, type Repo } from '@shared/types'
import { NewSessionModal } from '../components/NewSessionModal'
import { useStore } from '../store/useStore'
import { installApi, resetStore } from './testStubs'

Object.assign(globalThis, { React })

const repo: Repo = { id: 'repo-1', name: 'Repo', path: 'D:/repo', addedAt: 1 }

describe('canvas launchers', () => {
  beforeEach(() => {
    installApi()
    resetStore()
  })

  afterEach(() => cleanup())

  test('openNewTerminal opens New Session with a one-shot terminal preset', () => {
    useStore.getState().openNewTerminal()
    expect(useStore.getState()).toMatchObject({
      showNewSession: true,
      newSessionPreset: 'terminal'
    })
    useStore.getState().toggleNewSession(false)
    expect(useStore.getState()).toMatchObject({
      showNewSession: false,
      newSessionPreset: null
    })
  })

  test('terminal preset submits a zero-agent request and opens the created shell', async () => {
    const createSession = vi.fn().mockResolvedValue({
      id: 'shell-1',
      repoId: repo.id,
      repoPath: repo.path,
      harness: null,
      title: 'Terminal',
      branch: 'main',
      worktreePath: repo.path,
      status: 'running',
      createdAt: 1,
      updatedAt: 1,
      kind: 'normal'
    })
    installApi({
      createSession,
      currentBranch: vi.fn().mockResolvedValue('main')
    })
    resetStore({
      repos: [repo],
      showNewSession: true,
      newSessionPreset: 'terminal',
      harnesses: [{ id: 'codex', available: true, info: HARNESS_INFO.codex }]
    })

    const user = userEvent.setup()
    render(<NewSessionModal />)

    expect(screen.queryByText('Terminal', { selector: 'button *' })).toBeNull()
    expect(screen.queryByLabelText('Model')).toBeNull()
    expect(screen.queryByLabelText('Repository')).toBeNull()
    expect(screen.queryByLabelText('New branch')).toBeNull()
    expect(screen.queryByText('Workspace')).toBeNull()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Launch' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Launch' }))

    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1))
    const request = createSession.mock.calls[0][0]
    expect(request).toMatchObject({
      repoId: repo.id,
      repoPath: repo.path,
      worktreePath: '',
      harness: null,
      createWorktree: {
        repoPath: repo.path,
        baseBranch: 'main',
        newBranch: true
      }
    })
    expect(request.branch).toMatch(/^conductor\/terminal-[0-9a-f]{6}$/)
    expect(request.createWorktree.branch).toBe(request.branch)
    expect(request).not.toHaveProperty('model')
    expect(request).not.toHaveProperty('initialPrompt')
    expect(window.api.listBranches).not.toHaveBeenCalled()
    expect(window.api.listWorktrees).not.toHaveBeenCalled()
    expect(useStore.getState()).toMatchObject({
      showNewSession: false,
      newSessionPreset: null,
      selectedSessionId: 'shell-1'
    })
    expect(useStore.getState().settings.canvas.panels).toEqual([
      expect.objectContaining({ id: 'session:shell-1', subjectId: 'shell-1' })
    ])
  })

  test('ordinary New Session still starts with the configured default harness', () => {
    resetStore({
      repos: [repo],
      settings: { ...structuredClone(DEFAULT_SETTINGS), defaultHarness: 'codex' },
      harnesses: [{ id: 'codex', available: true, info: HARNESS_INFO.codex }],
      showNewSession: true,
      newSessionPreset: null
    })

    render(<NewSessionModal />)

    expect(screen.getByText('Codex').closest('button')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByLabelText('Role preset')).toBeInTheDocument()
  })
})
