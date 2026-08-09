// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { CanvasPanel, Session, PublicRavelConfig } from '@shared/types'
import { Dock } from './Dock'

Object.assign(globalThis, { React })

const mockSession: Session = {
  id: 'sess-1',
  kind: 'normal',
  title: 'Test Session',
  harness: 'claude',
  parentId: null,
  ravelId: null,
  ravelRole: null,
  briefId: null,
  status: 'running',
  branch: 'main',
  repoId: 'repo-1',
  repoPath: '/repo',
  worktreePath: '/repo/.worktrees/test',
  initialPrompt: 'Test prompt',
  createdAt: Date.now(),
  lastActivityAt: Date.now()
}

const mockRavel: PublicRavelConfig = {
  id: 'ravel-1',
  name: 'Test Ravel',
  harness: 'codex',
  model: null,
  status: 'running',
  activity: 'thinking',
  repoId: 'repo-1',
  repoPath: '/repo',
  createdAt: Date.now(),
  maxChildren: 4,
  allowRisky: false,
  managerSessionId: null,
  messages: [],
  plan: null,
  dispatches: [],
  error: null,
  usage: { inputTokens: 0, outputTokens: 0, costUsd: null }
}


const sessionPanel: CanvasPanel = {
  id: 'session:sess-1',
  kind: 'session',
  subjectId: 'sess-1',
  x: 100,
  y: 100,
  w: 400,
  h: 300,
  z: 1,
  minimized: true
}

const ravelPanel: CanvasPanel = {
  id: 'ravel:ravel-1',
  kind: 'ravel',
  subjectId: 'ravel-1',
  x: 200,
  y: 200,
  w: 400,
  h: 300,
  z: 2,
  minimized: true
}

const settingsPanel: CanvasPanel = {
  id: 'settings',
  kind: 'settings',
  subjectId: null,
  x: 300,
  y: 300,
  w: 400,
  h: 300,
  z: 3,
  minimized: true
}

afterEach(cleanup)

describe('Dock', () => {
  test('renders null when no panels are minimized', () => {
    const { container } = render(
      <Dock
        panels={[]}
        sessions={[]}
        ravels={[]}
        roundtables={[]}
        onRestore={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect(container.firstChild).toBeNull()
  })

  test('renders dock strip when panels are minimized', () => {
    render(
      <Dock
        panels={[sessionPanel]}
        sessions={[mockSession]}
        ravels={[]}
        roundtables={[]}
        onRestore={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByTestId('dock')).toBeInTheDocument()
  })

  test('renders a chip for each minimized panel', () => {
    render(
      <Dock
        panels={[sessionPanel, ravelPanel, settingsPanel]}
        sessions={[mockSession]}
        ravels={[mockRavel]}
        roundtables={[]}
        onRestore={vi.fn()}
        onClose={vi.fn()}
      />
    )
    const chips = screen.getAllByTestId('dock-chip')
    expect(chips).toHaveLength(3)
  })

  test('shows session harness for normal sessions', () => {
    render(
      <Dock
        panels={[sessionPanel]}
        sessions={[mockSession]}
        ravels={[]}
        roundtables={[]}
        onRestore={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText('claude')).toBeInTheDocument()
  })

  test('shows ravel name in chip label', () => {
    render(
      <Dock
        panels={[ravelPanel]}
        sessions={[]}
        ravels={[mockRavel]}
        roundtables={[]}
        onRestore={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText('Test Ravel')).toBeInTheDocument()
  })

  test('shows activity badge for session with working state', () => {
    render(
      <Dock
        panels={[sessionPanel]}
        sessions={[mockSession]}
        ravels={[]}
        roundtables={[]}
        onRestore={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByTestId('activity-working')).toBeInTheDocument()
  })

  test('clicking chip calls onRestore with panel id', () => {
    const onRestore = vi.fn()
    render(
      <Dock
        panels={[sessionPanel]}
        sessions={[mockSession]}
        ravels={[]}
        roundtables={[]}
        onRestore={onRestore}
        onClose={vi.fn()}
      />
    )
    fireEvent.click(screen.getByTestId('dock-chip'))
    expect(onRestore).toHaveBeenCalledWith('session:sess-1')
  })

  test('clicking close button calls onClose with panel id', () => {
    const onClose = vi.fn()
    render(
      <Dock
        panels={[sessionPanel]}
        sessions={[mockSession]}
        ravels={[]}
        roundtables={[]}
        onRestore={vi.fn()}
        onClose={onClose}
      />
    )
    const closeButton = screen.getByLabelText('Close claude')
    fireEvent.click(closeButton)
    expect(onClose).toHaveBeenCalledWith('session:sess-1')
  })

  test('close button click does not trigger restore', () => {
    const onRestore = vi.fn()
    const onClose = vi.fn()
    render(
      <Dock
        panels={[sessionPanel]}
        sessions={[mockSession]}
        ravels={[]}
        roundtables={[]}
        onRestore={onRestore}
        onClose={onClose}
      />
    )
    const closeButton = screen.getByLabelText('Close claude')
    fireEvent.click(closeButton)
    expect(onRestore).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('shows generic label for singleton panels', () => {
    render(
      <Dock
        panels={[settingsPanel]}
        sessions={[]}
        ravels={[]}
        roundtables={[]}
        onRestore={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText('Settings')).toBeInTheDocument()
  })

  test('handles missing session gracefully', () => {
    render(
      <Dock
        panels={[sessionPanel]}
        sessions={[]}
        ravels={[]}
        roundtables={[]}
        onRestore={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText('Session')).toBeInTheDocument()
  })
})
