// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { DEFAULT_SETTINGS, HARNESS_INFO } from '@shared/types'
import type { HarnessAvailability, CanvasPanel } from '@shared/types'
import { installApi, resetStore } from '../lib/testStubs'
import { Canvas } from './Canvas'
import { useStore } from '../store/useStore'

Object.assign(globalThis, { React })


// Canvas wires a ResizeObserver in an effect; jsdom has none. A no-op stub is
// enough — the first measurement runs synchronously before observe().
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub

const noPanels = {
  ...DEFAULT_SETTINGS,
  canvas: { ...DEFAULT_SETTINGS.canvas, panels: [] }
}

const REPO = { id: 'repo-1', path: 'D:/myrepo', name: 'myrepo', addedAt: 1 }

function harness(id: HarnessAvailability['id'], available: boolean): HarnessAvailability {
  return { id, info: HARNESS_INFO[id], available }
}

beforeEach(() => {
  installApi()
  resetStore({ settings: noPanels })
})

afterEach(cleanup)

describe('Canvas first-run empty state', () => {
  test('renders the no-repos overlay with an enabled add button when there are no repos', () => {
    render(<Canvas />)

    expect(screen.getByTestId('no-repos-empty-state')).toBeInTheDocument()
    expect(screen.getByTestId('add-repository')).not.toBeDisabled()
  })

  test('clicking add-repository picks a directory then adds it through the store', async () => {
    installApi({ pickDirectory: vi.fn().mockResolvedValue('D:/myrepo') })
    render(<Canvas />)

    fireEvent.click(screen.getByTestId('add-repository'))

    await waitFor(() => {
      expect(window.api.pickDirectory).toHaveBeenCalled()
      expect(window.api.addRepo).toHaveBeenCalledWith('D:/myrepo')
    })
  })

  test('shows the install hint when no harnesses are available', () => {
    useStoreHarnesses([harness('claude', false), harness('codex', false)])
    render(<Canvas />)

    const status = screen.getByTestId('harness-status')
    expect(status.textContent?.toLowerCase()).toContain('install')
  })

  test('does not render the overlay once a repository exists', () => {
    resetStore({ settings: noPanels, repos: [REPO] })
    render(<Canvas />)

    expect(screen.queryByTestId('no-repos-empty-state')).toBeNull()
  })
})

describe('Dock for minimized panels', () => {
  test('does not render dock when no panels are minimized', () => {
    const panel: CanvasPanel = {
      id: 'sessions',
      kind: 'sessions',
      subjectId: null,
      x: 100,
      y: 100,
      w: 400,
      h: 300,
      z: 1,
      minimized: false
    }
    resetStore({ 
      settings: { ...DEFAULT_SETTINGS, canvas: { ...DEFAULT_SETTINGS.canvas, panels: [panel] } },
      repos: [REPO]
    })
    render(<Canvas />)

    expect(screen.queryByTestId('dock')).toBeNull()
  })

  test('renders dock when a panel is minimized', () => {
    const panel: CanvasPanel = {
      id: 'sessions',
      kind: 'sessions',
      subjectId: null,
      x: 100,
      y: 100,
      w: 400,
      h: 300,
      z: 1,
      minimized: true
    }
    resetStore({ 
      settings: { ...DEFAULT_SETTINGS, canvas: { ...DEFAULT_SETTINGS.canvas, panels: [panel] } },
      repos: [REPO]
    })
    render(<Canvas />)

    expect(screen.getByTestId('dock')).toBeInTheDocument()
  })

  test('minimized panel does not render on canvas', () => {
    const minimizedPanel: CanvasPanel = {
      id: 'sessions',
      kind: 'sessions',
      subjectId: null,
      x: 100,
      y: 100,
      w: 400,
      h: 300,
      z: 1,
      minimized: true
    }
    const visiblePanel: CanvasPanel = {
      id: 'work',
      kind: 'work',
      subjectId: null,
      x: 200,
      y: 200,
      w: 400,
      h: 300,
      z: 2,
      minimized: false
    }
    resetStore({ 
      settings: { ...DEFAULT_SETTINGS, canvas: { ...DEFAULT_SETTINGS.canvas, panels: [minimizedPanel, visiblePanel] } },
      repos: [REPO]
    })
    render(<Canvas />)

    const canvasPanels = screen.getAllByTestId('canvas-panel')
    expect(canvasPanels).toHaveLength(1)
    expect(canvasPanels[0]).toHaveAttribute('data-panel-kind', 'work')
  })

  test('clicking dock chip restores panel', async () => {
    const panel: CanvasPanel = {
      id: 'sessions',
      kind: 'sessions',
      subjectId: null,
      x: 100,
      y: 100,
      w: 400,
      h: 300,
      z: 1,
      minimized: true
    }
    resetStore({ 
      settings: { ...DEFAULT_SETTINGS, canvas: { ...DEFAULT_SETTINGS.canvas, panels: [panel] } },
      repos: [REPO]
    })
    render(<Canvas />)

    const chip = screen.getByTestId('dock-chip')
    fireEvent.click(chip)

    // After restore, panel should be visible on canvas and dock should be gone
    expect(screen.queryByTestId('dock')).toBeNull()
    expect(screen.getByTestId('canvas-panel')).toBeInTheDocument()
  })
})

function useStoreHarnesses(harnesses: HarnessAvailability[]): void {
  useStore.setState({ harnesses })
}
