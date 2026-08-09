// @vitest-environment jsdom
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { DEFAULT_CANVAS_LAYOUT_VERSION, DEFAULT_SETTINGS, type CanvasPanel } from '@shared/types'
import { installApi, resetStore } from './testStubs'
import { useStore } from '../store/useStore'

const existing: CanvasPanel = {
  id: 'sessions',
  kind: 'sessions',
  subjectId: null,
  x: 81,
  y: 39,
  w: 300,
  h: 280,
  z: 1,
  minimized: false
}

describe('measured canvas store integration', () => {
  beforeEach(() => {
    installApi()
    resetStore()
  })

  test('does not drop a minimize toggle before the canvas is measured', () => {
    const saveSettings = vi.mocked(window.api.saveSettings)
    resetStore({
      canvasReady: true,
      canvasViewport: null,
      settings: {
        ...structuredClone(DEFAULT_SETTINGS),
        canvas: {
          panels: [existing],
          layouts: [],
          activeLayoutId: null,
          defaultLayoutVersion: DEFAULT_CANVAS_LAYOUT_VERSION
        }
      }
    })
    saveSettings.mockClear()

    useStore.getState().togglePanelMinimized('sessions')

    expect(useStore.getState().settings.canvas.panels[0].minimized).toBe(true)
    expect(saveSettings).toHaveBeenCalledTimes(1)
  })

  test('defers measured initialization until persisted settings load', async () => {
    const loaded = {
      ...structuredClone(DEFAULT_SETTINGS),
      canvas: {
        panels: [existing],
        layouts: [],
        activeLayoutId: null,
        defaultLayoutVersion: 0
      }
    }
    const saveSettings = vi.fn().mockResolvedValue(loaded)
    installApi({
      getSettings: vi.fn().mockResolvedValue(loaded),
      saveSettings
    })

    useStore.getState().initializeCanvas(1280, 720)
    expect(saveSettings).not.toHaveBeenCalled()

    await useStore.getState().init()

    expect(useStore.getState().settings.canvas).toMatchObject({
      panels: [existing],
      defaultLayoutVersion: DEFAULT_CANVAS_LAYOUT_VERSION
    })
    expect(saveSettings).toHaveBeenCalledWith({
      canvas: expect.objectContaining({
        panels: [existing],
        defaultLayoutVersion: DEFAULT_CANVAS_LAYOUT_VERSION
      })
    })
  })

  test('reset uses the latest measured viewport and preserves named layouts', () => {
    const named = {
      id: 'review',
      name: 'Review',
      panels: [existing]
    }
    resetStore({
      canvasReady: true,
      settings: {
        ...structuredClone(DEFAULT_SETTINGS),
        canvas: {
          panels: [existing],
          layouts: [named],
          activeLayoutId: named.id,
          defaultLayoutVersion: DEFAULT_CANVAS_LAYOUT_VERSION
        }
      }
    })

    useStore.getState().initializeCanvas(960, 528)
    useStore.getState().resetCanvasToDefault()

    const canvas = useStore.getState().settings.canvas
    expect(canvas.layouts).toEqual([named])
    expect(canvas.activeLayoutId).toBeNull()
    expect(canvas.panels.map((panel) => panel.id)).toEqual(['sessions', 'work', 'fleet'])
    expect(canvas.panels.every((panel) => panel.x + panel.w <= 960 && panel.y + panel.h <= 528)).toBe(true)
  })

  test('contains restored geometry as soon as settings and viewport are ready', async () => {
    const offscreen = { ...existing, x: 1400, y: 900, w: 500, h: 400 }
    const loaded = {
      ...structuredClone(DEFAULT_SETTINGS),
      canvas: {
        panels: [offscreen],
        layouts: [],
        activeLayoutId: null,
        defaultLayoutVersion: DEFAULT_CANVAS_LAYOUT_VERSION
      }
    }
    const saveSettings = vi.fn().mockResolvedValue(loaded)
    installApi({
      getSettings: vi.fn().mockResolvedValue(loaded),
      saveSettings
    })

    useStore.getState().initializeCanvas(960, 528)
    await useStore.getState().init()

    expect(useStore.getState().settings.canvas.panels[0]).toMatchObject({
      x: 460,
      y: 128,
      w: 500,
      h: 400
    })
    expect(saveSettings).toHaveBeenCalledWith({ canvas: expect.any(Object) })
  })

  test('commits geometry against the latest measured viewport', () => {
    resetStore({
      canvasReady: true,
      canvasViewport: { width: 960, height: 528 },
      settings: {
        ...structuredClone(DEFAULT_SETTINGS),
        canvas: {
          panels: [existing],
          layouts: [],
          activeLayoutId: null,
          defaultLayoutVersion: DEFAULT_CANVAS_LAYOUT_VERSION
        }
      }
    })

    useStore
      .getState()
      .setPanelGeometry('sessions', { x: 2000, y: 2000, w: 300, h: 280 })
    expect(useStore.getState().settings.canvas.panels[0]).toMatchObject({
      x: 660,
      y: 248,
      w: 300,
      h: 280
    })
  })

  test('expands a minimized panel within the measured viewport and persists once', () => {
    const saveSettings = vi.mocked(window.api.saveSettings)
    resetStore({
      canvasReady: true,
      canvasViewport: { width: 960, height: 528 },
      settings: {
        ...structuredClone(DEFAULT_SETTINGS),
        canvas: {
          panels: [{ ...existing, y: 494, minimized: true }],
          layouts: [],
          activeLayoutId: null,
          defaultLayoutVersion: DEFAULT_CANVAS_LAYOUT_VERSION
        }
      }
    })
    saveSettings.mockClear()

    useStore.getState().togglePanelMinimized('sessions')

    expect(useStore.getState().settings.canvas.panels[0]).toMatchObject({
      y: 248,
      minimized: false
    })
    expect(saveSettings).toHaveBeenCalledTimes(1)
  })

  test('does not persist a reflow when every panel is already contained', () => {
    const saveSettings = vi.mocked(window.api.saveSettings)
    resetStore({
      canvasReady: true,
      canvasViewport: { width: 960, height: 528 },
      settings: {
        ...structuredClone(DEFAULT_SETTINGS),
        canvas: {
          panels: [existing],
          layouts: [],
          activeLayoutId: null,
          defaultLayoutVersion: DEFAULT_CANVAS_LAYOUT_VERSION
        }
      }
    })
    saveSettings.mockClear()

    useStore.getState().reflowCanvas(960, 528)

    expect(saveSettings).not.toHaveBeenCalled()
  })

  test('contains a named layout when applying it on a smaller viewport', () => {
    const named = {
      id: 'large',
      name: 'Large',
      panels: [{ ...existing, x: 1400, y: 900, w: 500, h: 400 }]
    }
    resetStore({
      canvasReady: true,
      canvasViewport: { width: 960, height: 528 },
      settings: {
        ...structuredClone(DEFAULT_SETTINGS),
        canvas: {
          panels: [],
          layouts: [named],
          activeLayoutId: null,
          defaultLayoutVersion: DEFAULT_CANVAS_LAYOUT_VERSION
        }
      }
    })

    useStore.getState().applyLayout('large')
    expect(useStore.getState().settings.canvas.panels[0]).toMatchObject({
      x: 460,
      y: 128,
      w: 500,
      h: 400
    })
  })
})
