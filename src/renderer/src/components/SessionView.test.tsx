// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Session } from '@shared/types'
import { installApi, resetStore } from '../lib/testStubs'
import { useStore } from '../store/useStore'
import { SessionView } from './SessionView'
Object.assign(globalThis, { React })

vi.mock('./Terminal', () => ({
  TerminalView: () => <div data-testid="terminal-view">terminal</div>
}))

vi.mock('./SeatBar', () => ({
  SeatBar: () => <div data-testid="seat-bar">seat bar</div>
}))

vi.mock('./DocumentWorkspace', () => ({
  DocumentWorkspace: () => <div data-testid="document-workspace">documents</div>,
  useDocumentWorkspace: () => ({
    state: { activeKeyBySession: {}, documents: new Map() },
    openDocument: vi.fn()
  })
}))

const session: Session = {
  id: 'session-1',
  repoId: 'repo-1',
  repoPath: 'D:/repo',
  worktreePath: 'D:/repo/.worktrees/session-1',
  branch: 'feature/inspector',
  status: 'running',
  title: 'Inspector session',
  initialPrompt: 'Inspect this worktree',
  createdAt: 1,
  lastActivityAt: 2,
  kind: 'normal',
  harness: 'claude',
  parentId: null,
  ravelId: null,
  ravelRole: null,
  briefId: null
}

beforeEach(() => {
  installApi({
    listDir: vi.fn().mockResolvedValue([
      { name: 'README.md', path: 'D:/repo/.worktrees/session-1/README.md', isDir: false }
    ])
  })
  resetStore({ sessions: [session], selectedSessionId: session.id })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('SessionView local inspector', () => {
  test('starts hidden in a floating session panel and exposes a collapsed toggle', () => {
    render(<SessionView sessionId={session.id} />)

    expect(screen.queryByRole('complementary', { name: 'Session inspector' })).toBeNull()
    const toggle = screen.getByTestId('session-inspector-toggle')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle).toHaveAttribute('aria-controls', 'session-inspector')
  })

  test('opens the inspector with session metadata and worktree files', async () => {
    render(<SessionView sessionId={session.id} />)

    fireEvent.click(screen.getByTestId('session-inspector-toggle'))

    expect(screen.getByRole('complementary', { name: 'Session inspector' })).toBeInTheDocument()
    expect(screen.getByText(session.branch)).toBeInTheDocument()
    expect(screen.getByText(session.worktreePath)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('README.md')).toBeInTheDocument())
  })

  test('closes from the sheet and restores focus to the toggle', () => {
    render(<SessionView sessionId={session.id} />)
    const toggle = screen.getByTestId('session-inspector-toggle')

    fireEvent.click(toggle)
    fireEvent.click(screen.getByTestId('session-inspector-close'))

    expect(screen.queryByRole('complementary', { name: 'Session inspector' })).toBeNull()
    expect(toggle).toHaveFocus()
  })

  test('Escape closes the inspector and restores focus to its toggle', () => {
    render(<SessionView sessionId={session.id} />)
    const toggle = screen.getByTestId('session-inspector-toggle')

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(screen.queryByRole('complementary', { name: 'Session inspector' })).toBeNull()
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle).toHaveFocus()
  })

  test('does not render inspector metadata while closed', () => {
    render(<SessionView sessionId={session.id} />)

    expect(screen.queryByText(session.branch)).toBeNull()
    expect(screen.queryByText(session.worktreePath)).toBeNull()
    expect(screen.queryByText('README.md')).toBeNull()
  })

  test('shows Close session for an active session and kills it after confirmation', async () => {
    const killSession = vi.spyOn(useStore.getState(), 'killSession').mockResolvedValue()
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(<SessionView sessionId={session.id} />)
    fireEvent.click(screen.getByRole('button', { name: 'Close session' }))

    await waitFor(() => expect(killSession).toHaveBeenCalledWith(session.id))
    expect(screen.queryByRole('button', { name: 'Delete session' })).toBeNull()
  })

  test('does not kill an active session when close is cancelled', () => {
    const killSession = vi.spyOn(useStore.getState(), 'killSession').mockResolvedValue()
    vi.spyOn(window, 'confirm').mockReturnValue(false)

    render(<SessionView sessionId={session.id} />)
    fireEvent.click(screen.getByRole('button', { name: 'Close session' }))

    expect(killSession).not.toHaveBeenCalled()
  })

  test('shows Delete session for a closed session and returns to dashboard after confirmation', () => {
    const closedSession = { ...session, status: 'closed' as const }
    const dismissSession = vi.spyOn(useStore.getState(), 'dismissSession')
    const closePanel = vi.spyOn(useStore.getState(), 'closePanel')
    const back = vi.spyOn(useStore.getState(), 'back')
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    resetStore({ sessions: [closedSession], selectedSessionId: closedSession.id })

    render(<SessionView sessionId={closedSession.id} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete session' }))

    expect(dismissSession).toHaveBeenCalledWith(closedSession.id)
    expect(closePanel).toHaveBeenCalledWith(`session:${closedSession.id}`)
    expect(back).toHaveBeenCalledOnce()
  })

  test('does not delete a closed session when deletion is cancelled', () => {
    const closedSession = { ...session, status: 'closed' as const }
    const dismissSession = vi.spyOn(useStore.getState(), 'dismissSession')
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    resetStore({ sessions: [closedSession], selectedSessionId: closedSession.id })

    render(<SessionView sessionId={closedSession.id} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete session' }))

    expect(dismissSession).not.toHaveBeenCalled()
  })
})

