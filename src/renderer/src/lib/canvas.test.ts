import { describe, expect, test } from 'vitest'
import {
  CANVAS_PANEL_MIN,
  DEFAULT_CANVAS_LAYOUT_VERSION,
  EMPTY_CANVAS,
  type CanvasPanel,
  type CanvasState
} from '@shared/types'
import {
  applyLayout,
  clampToViewport,
  closePanel,
  commandCentrePanels,
  constrainRect,
  deleteLayout,
  initializeDefaultCanvas,
  moveRect,
  normalizeZ,
  openPanel,
  raisePanel,
  resetToCommandCentre,
  resizeRect,
  saveLayout,
  setGeometry,
  toggleMinimized
} from './canvas'

const empty = (): CanvasState => structuredClone(EMPTY_CANVAS)
const ids = (state: CanvasState): string[] => [...state.panels].sort((a, b) => a.z - b.z).map((p) => p.id)

function overlaps(a: CanvasPanel, b: CanvasPanel): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

function expectCommandCentre(width: number, height: number): void {
  const panels = commandCentrePanels(width, height)
  expect(panels.map((panel) => panel.id)).toEqual(['sessions', 'work', 'fleet'])
  for (const panel of panels) {
    expect(panel.x).toBeGreaterThanOrEqual(0)
    expect(panel.y).toBeGreaterThanOrEqual(0)
    expect(panel.x + panel.w).toBeLessThanOrEqual(width)
    expect(panel.y + panel.h).toBeLessThanOrEqual(height)
    expect(panel.w).toBeGreaterThanOrEqual(CANVAS_PANEL_MIN.w)
    expect(panel.h).toBeGreaterThanOrEqual(CANVAS_PANEL_MIN.h)
  }
  expect(overlaps(panels[0], panels[1])).toBe(false)
  expect(overlaps(panels[0], panels[2])).toBe(false)
  expect(overlaps(panels[1], panels[2])).toBe(false)
  expect(panels.map((panel) => panel.z)).toEqual([1, 2, 3])
}

const VIEWPORT = { width: 1280, height: 720 }

function panelById(state: CanvasState, id: string): CanvasPanel {
  const panel = state.panels.find((entry) => entry.id === id)
  if (!panel) throw new Error(`missing panel ${id}`)
  return panel
}

describe('opening panels', () => {
  test('a singleton opens once and is raised on re-open, not duplicated', () => {
    let state = openPanel(openPanel(empty(), 'sessions'), 'fleet')
    expect(ids(state)).toEqual(['sessions', 'fleet'])
    state = openPanel(state, 'sessions')
    expect(state.panels).toHaveLength(2)
    expect(ids(state)).toEqual(['fleet', 'sessions'])
  })

  test('subject panels open once per subject', () => {
    let state = openPanel(empty(), 'ravel', 'r1')
    state = openPanel(state, 'ravel', 'r2')
    state = openPanel(state, 'ravel', 'r1')
    expect(state.panels.map((p) => p.id).sort()).toEqual(['ravel:r1', 'ravel:r2'])
  })

  test('re-opening a minimized panel expands it — you asked to see it', () => {
    let state = openPanel(empty(), 'ravel', 'r1')
    state = toggleMinimized(state, 'ravel:r1', VIEWPORT)
    expect(state.panels[0].minimized).toBe(true)
    state = openPanel(state, 'ravel', 'r1')
    expect(state.panels[0].minimized).toBe(false)
  })

})

describe('overlap-aware placement', () => {
  test('a new session opens in the empty Command Centre stage without moving rails', () => {
    const initial = resetToCommandCentre(empty(), VIEWPORT.width, VIEWPORT.height)
    const rails = initial.panels.map((panel) => ({ ...panel }))
    const next = openPanel(initial, 'session', 's1', VIEWPORT)
    const session = panelById(next, 'session:s1')
    expect(next.panels.slice(0, 3)).toEqual(rails)
    for (const rail of rails) expect(overlaps(session, rail)).toBe(false)
  })

  test('placement is deterministic when every zero-overlap slot is occupied', () => {
    let state = resetToCommandCentre(empty(), VIEWPORT.width, VIEWPORT.height)
    state = openPanel(state, 'ravel', 'r1', VIEWPORT)
    const once = openPanel(state, 'session', 's1', VIEWPORT)
    const twice = openPanel(state, 'session', 's1', VIEWPORT)
    expect(panelById(once, 'session:s1')).toEqual(panelById(twice, 'session:s1'))
  })

  test('reopening an existing panel expands and raises without moving it', () => {
    let state = openPanel(empty(), 'ravel', 'r1', VIEWPORT)
    state = setGeometry(state, 'ravel:r1', { x: 119, y: 87, w: 640, h: 430 }, VIEWPORT)
    state = toggleMinimized(state, 'ravel:r1', VIEWPORT)
    const next = openPanel(state, 'ravel', 'r1', VIEWPORT)
    expect(panelById(next, 'ravel:r1')).toMatchObject({
      x: 119,
      y: 87,
      w: 640,
      h: 430,
      minimized: false
    })
  })

  test('reopening a minimized panel pulls its full body back into view', () => {
    let state = openPanel(empty(), 'ravel', 'r1', VIEWPORT)
    state = toggleMinimized(state, 'ravel:r1', VIEWPORT)
    state = setGeometry(state, 'ravel:r1', { x: 40, y: 2000, w: 400, h: 300 }, VIEWPORT)
    expect(panelById(state, 'ravel:r1')).toMatchObject({ y: 686, minimized: true })

    state = openPanel(state, 'ravel', 'r1', VIEWPORT)
    expect(panelById(state, 'ravel:r1')).toMatchObject({ y: 420, minimized: false })
  })

  test('a full-canvas fallback is deterministic and keeps the new header reachable', () => {
    const occupied = setGeometry(
      openPanel(empty(), 'settings', null, VIEWPORT),
      'settings',
      { x: 0, y: 0, w: VIEWPORT.width, h: VIEWPORT.height },
      VIEWPORT
    )
    const once = openPanel(occupied, 'session', 's1', VIEWPORT)
    const twice = openPanel(occupied, 'session', 's1', VIEWPORT)
    const firstPanel = panelById(once, 'session:s1')
    expect(firstPanel).toEqual(panelById(twice, 'session:s1'))
    expect(firstPanel.x).toBeGreaterThanOrEqual(0)
    expect(firstPanel.y).toBeGreaterThanOrEqual(0)
    expect(firstPanel.x + firstPanel.w).toBeLessThanOrEqual(VIEWPORT.width)
    expect(firstPanel.y + firstPanel.h).toBeLessThanOrEqual(VIEWPORT.height)
  })
})

describe('Command Centre', () => {
  test.each([
    [960, 528],
    [1280, 720],
    [1452, 846],
    [1600, 900]
  ])('generates a non-overlapping Command Centre at %d×%d', expectCommandCentre)

  test('uses the approved Command Centre proportions', () => {
    expect(commandCentrePanels(1280, 720)).toMatchObject([
      { id: 'sessions', x: 12, y: 12, w: 256, h: 356 },
      { id: 'work', x: 12, y: 380, w: 256, h: 328 },
      { id: 'fleet', x: 1048, y: 12, w: 220, h: 696 }
    ])
  })

  test('preserves an existing old arrangement while marking it initialized', () => {
    const arranged = setGeometry(
      openPanel(empty(), 'sessions'),
      'sessions',
      { x: 91, y: 47, w: 330, h: 250 },
      VIEWPORT
    )
    const next = initializeDefaultCanvas(arranged, 1280, 720)
    expect(next.panels).toEqual(arranged.panels)
    expect(next.defaultLayoutVersion).toBe(DEFAULT_CANVAS_LAYOUT_VERSION)
  })

  test('an initialized empty canvas remains empty', () => {
    const state = { ...empty(), defaultLayoutVersion: DEFAULT_CANVAS_LAYOUT_VERSION }
    expect(initializeDefaultCanvas(state, 1280, 720)).toBe(state)
  })

  test('reset preserves named layouts but replaces visible panels', () => {
    let state = saveLayout(openPanel(empty(), 'settings'), 'Review', 'layout-review')
    state = resetToCommandCentre(state, 1280, 720)
    expect(state.layouts.map((layout) => layout.name)).toEqual(['Review'])
    expect(state.panels.map((panel) => panel.id)).toEqual(['sessions', 'work', 'fleet'])
    expect(state.activeLayoutId).toBeNull()
  })

  test('reset contains its generated layout even below the application minimum', () => {
    const state = resetToCommandCentre(empty(), 200, 120)
    expect(
      state.panels.every(
        (panel) => panel.x >= 0 && panel.y >= 0 && panel.x + panel.w <= 200 && panel.y + panel.h <= 120
      )
    ).toBe(true)
  })
})

describe('z-order', () => {
  /** Raise-by-max would let z climb forever and end up persisted as a huge number. */
  test('stays 1..n however many times panels are raised', () => {
    let state = openPanel(openPanel(openPanel(empty(), 'sessions'), 'work'), 'fleet')
    for (let i = 0; i < 50; i += 1) {
      state = raisePanel(state, i % 2 === 0 ? 'sessions' : 'fleet')
    }
    expect([...state.panels].map((p) => p.z).sort((a, b) => a - b)).toEqual([1, 2, 3])
  })

  test('raising puts a panel in front and keeps the others in order', () => {
    let state = openPanel(openPanel(openPanel(empty(), 'sessions'), 'work'), 'fleet')
    state = raisePanel(state, 'sessions')
    expect(ids(state)).toEqual(['work', 'fleet', 'sessions'])
  })

  test('raising the frontmost panel changes nothing', () => {
    const state = openPanel(openPanel(empty(), 'sessions'), 'fleet')
    expect(raisePanel(state, 'fleet')).toBe(state)
  })

  test('closing renumbers so no gap is left behind', () => {
    let state = openPanel(openPanel(openPanel(empty(), 'sessions'), 'work'), 'fleet')
    state = closePanel(state, 'work')
    expect([...state.panels].map((p) => p.z).sort((a, b) => a - b)).toEqual([1, 2])
  })
})

describe('geometry', () => {
  test('clamps to the minimum usable size and never a negative origin', () => {
    let state = openPanel(empty(), 'ravel', 'r1')
    state = setGeometry(state, 'ravel:r1', { x: -50, y: -10, w: 10, h: 10 }, VIEWPORT)
    expect(state.panels[0]).toMatchObject({ x: 0, y: 0, w: 220, h: 140 })
  })

  test('leaves other panels untouched', () => {
    let state = openPanel(openPanel(empty(), 'sessions'), 'fleet')
    const before = state.panels.find((p) => p.id === 'fleet')
    state = setGeometry(state, 'sessions', { x: 300, y: 200, w: 400, h: 300 }, VIEWPORT)
    expect(state.panels.find((p) => p.id === 'fleet')).toEqual(before)
  })
})

describe('re-homing a layout saved on a bigger screen', () => {
  test('drags off-screen panels back far enough to grab', () => {
    let state = openPanel(empty(), 'ravel', 'r1')
    state = setGeometry(
      state,
      'ravel:r1',
      { x: 3000, y: 900, w: 900, h: 600 },
      { width: 4000, height: 2000 }
    )
    state = clampToViewport(state, 1280, 720)
    const panel = state.panels[0]
    expect(panel.x + panel.w).toBeLessThanOrEqual(1280)
    expect(panel.y + panel.h).toBeLessThanOrEqual(720)
  })

  test('shrinks a panel wider than the window but keeps a usable size', () => {
    let state = openPanel(empty(), 'ravel', 'r1')
    state = setGeometry(
      state,
      'ravel:r1',
      { x: 0, y: 0, w: 2000, h: 1500 },
      { width: 2400, height: 1800 }
    )
    state = clampToViewport(state, 800, 600)
    expect(state.panels[0].w).toBe(800)
    expect(state.panels[0].h).toBe(600)
  })

  test('a panel already in view is not moved', () => {
    let state = openPanel(empty(), 'ravel', 'r1')
    state = setGeometry(
      state,
      'ravel:r1',
      { x: 40, y: 40, w: 400, h: 300 },
      { width: 1440, height: 900 }
    )
    const before = state.panels[0]
    expect(clampToViewport(state, 1440, 900).panels[0]).toEqual(before)
  })
})

describe('full viewport containment', () => {
  test('clamps committed geometry to every canvas edge', () => {
    let state = openPanel(empty(), 'ravel', 'r1', VIEWPORT)
    state = setGeometry(
      state,
      'ravel:r1',
      { x: -80, y: 900, w: 900, h: 600 },
      VIEWPORT
    )
    expect(panelById(state, 'ravel:r1')).toMatchObject({
      x: 0,
      y: 120,
      w: 900,
      h: 600
    })
  })

  test('stops a moved panel at the right and bottom edges', () => {
    expect(moveRect({ x: 40, y: 30, w: 400, h: 300 }, 2000, 2000, VIEWPORT, false)).toEqual({
      x: 880,
      y: 420,
      w: 400,
      h: 300
    })
  })

  test('keeps a minimized panel header fully visible', () => {
    expect(moveRect({ x: 40, y: 30, w: 400, h: 300 }, 2000, 2000, VIEWPORT, true)).toEqual({
      x: 880,
      y: 686,
      w: 400,
      h: 300
    })
  })

  test('expanding a minimized panel pulls its full body back into view', () => {
    let state = openPanel(empty(), 'ravel', 'r1', VIEWPORT)
    state = toggleMinimized(state, 'ravel:r1', VIEWPORT)
    state = setGeometry(state, 'ravel:r1', { x: 40, y: 2000, w: 400, h: 300 }, VIEWPORT)

    state = toggleMinimized(state, 'ravel:r1', VIEWPORT)
    expect(panelById(state, 'ravel:r1')).toMatchObject({ y: 420, minimized: false })
  })

  test('stops east and south resize edges at the viewport', () => {
    expect(
      resizeRect({ x: 100, y: 80, w: 400, h: 300 }, 'se', 2000, 2000, VIEWPORT)
    ).toEqual({ x: 100, y: 80, w: 1180, h: 640 })
  })

  test('stops west and north resize edges at zero', () => {
    expect(
      resizeRect({ x: 100, y: 80, w: 400, h: 300 }, 'nw', -2000, -2000, VIEWPORT)
    ).toEqual({ x: 0, y: 0, w: 500, h: 380 })
  })

  test('fully contains a layout saved on a larger viewport', () => {
    const largeViewport = { width: 4000, height: 2000 }
    let state = openPanel(empty(), 'ravel', 'r1', largeViewport)
    state = setGeometry(
      state,
      'ravel:r1',
      { x: 3000, y: 900, w: 900, h: 600 },
      largeViewport
    )
    state = saveLayout(state, 'Large', 'large')
    const applied = applyLayout({ ...state, panels: [] }, 'large', VIEWPORT)
    const panel = panelById(applied, 'ravel:r1')
    expect(panel.x + panel.w).toBeLessThanOrEqual(VIEWPORT.width)
    expect(panel.y + panel.h).toBeLessThanOrEqual(VIEWPORT.height)
  })

  test('returns the same rectangle values when already contained', () => {
    expect(constrainRect({ x: 20, y: 30, w: 400, h: 300 }, VIEWPORT)).toEqual({
      x: 20,
      y: 30,
      w: 400,
      h: 300
    })
  })
})

describe('saved layouts', () => {
  test('saves the current arrangement and makes it active', () => {
    let state = openPanel(openPanel(empty(), 'sessions'), 'fleet')
    state = saveLayout(state, 'Deep work', 'l1')
    expect(state.layouts).toHaveLength(1)
    expect(state.layouts[0].name).toBe('Deep work')
    expect(state.activeLayoutId).toBe('l1')
  })

  test('re-saving the same name replaces it rather than making a twin', () => {
    let state = saveLayout(openPanel(empty(), 'sessions'), 'Deep work', 'l1')
    state = openPanel(state, 'fleet')
    state = saveLayout(state, 'deep work', 'l2')
    expect(state.layouts).toHaveLength(1)
    expect(state.layouts[0].id).toBe('l1')
    expect(state.layouts[0].panels).toHaveLength(2)
  })

  test('refuses a blank name instead of saving an unnameable layout', () => {
    const state = openPanel(empty(), 'sessions')
    expect(saveLayout(state, '   ')).toBe(state)
  })

  test('applying restores the saved arrangement', () => {
    let state = openPanel(empty(), 'sessions')
    state = setGeometry(state, 'sessions', { x: 500, y: 400, w: 300, h: 300 }, VIEWPORT)
    state = saveLayout(state, 'Corner', 'l1')
    state = setGeometry(state, 'sessions', { x: 10, y: 10, w: 250, h: 250 }, VIEWPORT)
    state = applyLayout(state, 'l1', VIEWPORT)
    expect(state.panels[0]).toMatchObject({ x: 500, y: 400, w: 300, h: 300 })
  })

  test('applying a layout does not alias its stored panels', () => {
    let state = saveLayout(openPanel(empty(), 'sessions'), 'Corner', 'l1')
    state = applyLayout(state, 'l1', VIEWPORT)
    state = setGeometry(state, 'sessions', { x: 999, y: 999, w: 400, h: 400 }, VIEWPORT)
    expect(state.layouts[0].panels[0].x).not.toBe(999)
  })

  test('deleting the active layout clears the pointer at it', () => {
    let state = saveLayout(openPanel(empty(), 'sessions'), 'Corner', 'l1')
    state = deleteLayout(state, 'l1')
    expect(state.layouts).toEqual([])
    expect(state.activeLayoutId).toBeNull()
  })

  test('applying an unknown layout is a no-op, not a wipe', () => {
    const state = openPanel(empty(), 'sessions')
    expect(applyLayout(state, 'nope', VIEWPORT)).toBe(state)
  })
})

describe('normalizeZ', () => {
  test('preserves relative order', () => {
    const panels = normalizeZ([
      { id: 'a', kind: 'fleet', subjectId: null, x: 0, y: 0, w: 300, h: 200, z: 90, minimized: false },
      { id: 'b', kind: 'work', subjectId: null, x: 0, y: 0, w: 300, h: 200, z: 5, minimized: false }
    ])
    expect(panels.map((p) => [p.id, p.z])).toEqual([
      ['b', 1],
      ['a', 2]
    ])
  })
})
