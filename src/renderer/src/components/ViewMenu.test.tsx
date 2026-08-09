// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  DEFAULT_CANVAS_LAYOUT_VERSION,
  DEFAULT_SETTINGS,
  type Session
} from '@shared/types'
import { installApi, ravelFixture, resetStore, roundtableFixture } from '../lib/testStubs'
import { useStore } from '../store/useStore'
import { ViewMenu } from './ViewMenu'

Object.assign(globalThis, { React })

const session: Session = {
  id: 'session-1',
  repoId: 'repo-1',
  repoPath: 'D:/repo',
  worktreePath: 'D:/repo',
  branch: 'main',
  status: 'running',
  title: 'PowerShell',
  initialPrompt: null,
  createdAt: 1,
  lastActivityAt: 1,
  kind: 'normal',
  harness: null,
  parentId: null,
  ravelId: null,
  ravelRole: null,
  briefId: null
}

beforeEach(() => {
  installApi()
  resetStore({
    canvasReady: true,
    canvasViewport: { width: 1280, height: 720 },
    sessions: [session],
    ravelList: [ravelFixture()],
    roundtables: [roundtableFixture()],
    settings: {
      ...structuredClone(DEFAULT_SETTINGS),
      canvas: {
        panels: [
          {
            id: 'ravel:ravel-1',
            kind: 'ravel',
            subjectId: 'ravel-1',
            x: 100,
            y: 80,
            w: 900,
            h: 600,
            z: 1,
            minimized: false
          }
        ],
        layouts: [],
        activeLayoutId: null,
        defaultLayoutVersion: DEFAULT_CANVAS_LAYOUT_VERSION
      }
    }
  })
})

afterEach(cleanup)

describe('View menu canvas windows', () => {
  test('lists fixed and dynamic windows with their open state', async () => {
    const user = userEvent.setup()
    render(<ViewMenu />)

    await user.click(screen.getByRole('button', { name: /view/i }))

    expect(screen.getByText('Canvas windows')).toBeInTheDocument()
    expect(screen.getByTestId('view-window-sessions')).toHaveAttribute(
      'aria-checked',
      'false'
    )
    expect(screen.getByTestId('view-window-session:session-1')).toHaveAttribute(
      'aria-checked',
      'false'
    )
    expect(screen.getByTestId('view-window-ravel:ravel-1')).toHaveAttribute(
      'aria-checked',
      'true'
    )
    expect(screen.getByTestId('view-window-roundtable:roundtable-1')).toHaveAttribute(
      'aria-checked',
      'false'
    )
    expect(screen.getByText('PowerShell')).toBeInTheDocument()
    expect(screen.getByText('Terminal')).toBeInTheDocument()
  })

  test('lists an open canvas window after its subject leaves the store collection', async () => {
    const user = userEvent.setup()
    useStore.setState({ ravelList: [] })
    render(<ViewMenu />)

    await user.click(screen.getByRole('button', { name: /view/i }))

    const row = screen.getByTestId('view-window-ravel:ravel-1')
    expect(row).toHaveAttribute('aria-checked', 'true')
    expect(row).toHaveTextContent('Ravel')
  })

  test('hides and restores a Ravel window without deleting the Ravel', async () => {
    const user = userEvent.setup()
    const deleteRavel = vi.mocked(window.api.deleteRavel)
    render(<ViewMenu />)

    await user.click(screen.getByRole('button', { name: /view/i }))
    const row = screen.getByTestId('view-window-ravel:ravel-1')
    await user.click(row)

    expect(useStore.getState().settings.canvas.panels).toEqual([])
    expect(row).toHaveAttribute('aria-checked', 'false')
    expect(deleteRavel).not.toHaveBeenCalled()

    await user.click(row)
    expect(useStore.getState().settings.canvas.panels[0]).toMatchObject({
      id: 'ravel:ravel-1',
      kind: 'ravel',
      subjectId: 'ravel-1'
    })
  })

  test('keeps existing workspace-part controls in a labelled section', async () => {
    const user = userEvent.setup()
    render(<ViewMenu />)

    await user.click(screen.getByRole('button', { name: /view/i }))

    expect(screen.getByText('Workspace parts')).toBeInTheDocument()
    expect(screen.getByRole('menuitemcheckbox', { name: 'Repositories rail' })).toBeChecked()
  })

  test('labels both menu groups for assistive technology', async () => {
    const user = userEvent.setup()
    render(<ViewMenu />)

    await user.click(screen.getByRole('button', { name: /view/i }))

    expect(screen.getByRole('group', { name: 'Canvas windows' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Workspace parts' })).toBeInTheDocument()
    expect(screen.getByRole('separator')).toBeInTheDocument()
  })
})
