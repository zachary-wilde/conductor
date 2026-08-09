import {
  CANVAS_DEFAULT_SIZE,
  CANVAS_HEADER_H,
  CANVAS_PANEL_MIN,
  CANVAS_SINGLETONS,
  DEFAULT_CANVAS_LAYOUT_VERSION,
  canvasPanelId,
  type CanvasLayout,
  type CanvasPanel,
  type CanvasPanelKind,
  type CanvasState
} from '@shared/types'

/**
 * Pure arrangement logic for the floating canvas.
 *
 * z-order normalisation, overlap-aware placement, re-homing panels saved on a
 * bigger monitor — are testable without mounting anything.
 */

const MARGIN = 12
const GUTTER = 12
const RIGHT_COLUMN_W = CANVAS_PANEL_MIN.w

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface CanvasViewport {
  width: number
  height: number
}

/** Stand-in until the canvas reports its measured size. */
export const DEFAULT_VIEWPORT: CanvasViewport = { width: 1280, height: 720 }

export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

export function constrainRect(
  rect: Rect,
  viewport: CanvasViewport,
  minimized = false
): Rect {
  const width = Math.max(1, Math.round(viewport.width))
  const height = Math.max(1, Math.round(viewport.height))
  const w = Math.min(width, Math.max(CANVAS_PANEL_MIN.w, Math.round(rect.w)))
  const h = Math.min(height, Math.max(CANVAS_PANEL_MIN.h, Math.round(rect.h)))
  const visibleHeight = minimized ? Math.min(CANVAS_HEADER_H, height) : h
  return {
    x: clamp(Math.round(rect.x), 0, Math.max(0, width - w)),
    y: clamp(Math.round(rect.y), 0, Math.max(0, height - visibleHeight)),
    w,
    h
  }
}

export function moveRect(
  start: Rect,
  dx: number,
  dy: number,
  viewport: CanvasViewport,
  minimized: boolean
): Rect {
  const contained = constrainRect(start, viewport, minimized)
  return constrainRect(
    { ...contained, x: contained.x + dx, y: contained.y + dy },
    viewport,
    minimized
  )
}

export function resizeRect(
  start: Rect,
  edge: ResizeEdge,
  dx: number,
  dy: number,
  viewport: CanvasViewport
): Rect {
  const contained = constrainRect(start, viewport)
  let left = contained.x
  let top = contained.y
  let right = contained.x + contained.w
  let bottom = contained.y + contained.h
  const minW = Math.min(CANVAS_PANEL_MIN.w, Math.max(1, Math.round(viewport.width)))
  const minH = Math.min(CANVAS_PANEL_MIN.h, Math.max(1, Math.round(viewport.height)))

  if (edge.includes('w')) left = clamp(left + dx, 0, right - minW)
  if (edge.includes('e')) right = clamp(right + dx, left + minW, viewport.width)
  if (edge.includes('n')) top = clamp(top + dy, 0, bottom - minH)
  if (edge.includes('s')) bottom = clamp(bottom + dy, top + minH, viewport.height)

  return { x: left, y: top, w: right - left, h: bottom - top }
}

function singleton(
  kind: 'sessions' | 'work' | 'fleet',
  rect: Rect,
  z: number
): CanvasPanel {
  return {
    id: kind,
    kind,
    subjectId: null,
    ...rect,
    z,
    minimized: false
  }
}

export function commandCentrePanels(width: number, height: number): CanvasPanel[] {
  const leftW = clamp(Math.round(width * 0.2), CANVAS_PANEL_MIN.w, 260)
  const usableH = Math.max(CANVAS_PANEL_MIN.h * 2 + GUTTER, Math.round(height) - MARGIN * 2)
  const splitH = usableH - GUTTER
  const sessionsH = clamp(
    Math.round(splitH * 0.52),
    CANVAS_PANEL_MIN.h,
    splitH - CANVAS_PANEL_MIN.h
  )
  const workH = splitH - sessionsH
  const fleetX = Math.max(MARGIN, Math.round(width) - MARGIN - RIGHT_COLUMN_W)

  return [
    singleton('sessions', { x: MARGIN, y: MARGIN, w: leftW, h: sessionsH }, 1),
    singleton('work', { x: MARGIN, y: MARGIN + sessionsH + GUTTER, w: leftW, h: workH }, 2),
    singleton('fleet', { x: fleetX, y: MARGIN, w: RIGHT_COLUMN_W, h: usableH }, 3)
  ]
}

const byZ = (a: CanvasPanel, b: CanvasPanel): number => a.z - b.z

/**
 * Rewrites z as 1..n in current order.
 *
 * Raising by "max + 1" alone lets z climb forever across a long session; after a
 * few thousand raises it stops being a small integer and starts being a number
 * nobody wants in a persisted file.
 */
export function normalizeZ(panels: readonly CanvasPanel[]): CanvasPanel[] {
  return [...panels].sort(byZ).map((panel, index) => ({ ...panel, z: index + 1 }))
}

function overlapArea(a: Rect, b: Rect): number {
  const width = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  const height = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  return width * height
}

function stageRect(viewport: CanvasViewport): Rect {
  const leftW = clamp(Math.round(viewport.width * 0.2), CANVAS_PANEL_MIN.w, 260)
  const x = MARGIN + leftW + GUTTER
  const rightEdge = viewport.width - MARGIN - RIGHT_COLUMN_W - GUTTER
  return {
    x,
    y: MARGIN,
    w: Math.max(CANVAS_PANEL_MIN.w, rightEdge - x),
    h: Math.max(CANVAS_PANEL_MIN.h, viewport.height - MARGIN * 2)
  }
}

function fitSize(
  size: { w: number; h: number },
  viewport: CanvasViewport
): { w: number; h: number } {
  return {
    w: Math.min(size.w, Math.max(CANVAS_PANEL_MIN.w, viewport.width - MARGIN * 2)),
    h: Math.min(size.h, Math.max(CANVAS_PANEL_MIN.h, viewport.height - MARGIN * 2))
  }
}

function compareScores(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return 0
}

/** Round, clamp into range, then dedupe and sort: the placement search order. */
function clampedCandidates(values: readonly number[], max: number): number[] {
  const clamped = values.map((value) => clamp(Math.round(value), 0, max))
  return [...new Set(clamped)].sort((a, b) => a - b)
}

function placePanel(
  panels: readonly CanvasPanel[],
  kind: CanvasPanelKind,
  viewport: CanvasViewport
): Rect {
  // Only the Command Centre rails have a home; every other kind gets undefined.
  const home = commandCentrePanels(viewport.width, viewport.height).find(
    (panel) => panel.kind === kind
  )
  const stage = stageRect(viewport)
  const size = home ?? fitSize(CANVAS_DEFAULT_SIZE[kind], viewport)
  const preferredRegion = home ?? stage
  const preferred = {
    x: home?.x ?? Math.round(stage.x + (stage.w - size.w) / 2),
    y: home?.y ?? Math.round(stage.y + (stage.h - size.h) / 2),
    w: size.w,
    h: size.h
  }
  const preferredX = preferredRegion.x + preferredRegion.w / 2
  const preferredY = preferredRegion.y + preferredRegion.h / 2
  const xCandidates = [
    preferred.x,
    0,
    Math.round((viewport.width - size.w) / 2),
    viewport.width - size.w
  ]
  const yCandidates = [
    preferred.y,
    0,
    Math.round((viewport.height - size.h) / 2),
    viewport.height - size.h
  ]

  for (const panel of panels) {
    if (panel.minimized) continue
    xCandidates.push(panel.x - size.w - GUTTER, panel.x, panel.x + panel.w + GUTTER)
    yCandidates.push(panel.y - size.h - GUTTER, panel.y, panel.y + panel.h + GUTTER)
  }

  const xs = clampedCandidates(xCandidates, Math.max(0, viewport.width - size.w))
  const ys = clampedCandidates(yCandidates, Math.max(0, viewport.height - size.h))
  let best: Rect | null = null
  let bestScore: readonly number[] | null = null

  for (const x of xs) {
    for (const y of ys) {
      const rect = { x, y, w: size.w, h: size.h }
      const score = [
        panels.reduce(
          (sum, panel) => sum + (panel.minimized ? 0 : overlapArea(rect, panel)),
          0
        ),
        (rect.x + rect.w / 2 - preferredX) ** 2 +
          (rect.y + rect.h / 2 - preferredY) ** 2,
        Math.max(0, rect.x + rect.w - viewport.width) +
          Math.max(0, rect.y + rect.h - viewport.height),
        rect.x,
        rect.y
      ] as const
      if (bestScore === null || compareScores(score, bestScore) < 0) {
        best = rect
        bestScore = score
      }
    }
  }

  return best ?? preferred
}

/**
 * Open a panel, or raise it if it is already on the canvas.
 *
 * Singleton kinds collapse onto one id, so asking for Settings twice focuses the
 * Settings panel rather than stacking a second copy of it.
 */
export function openPanel(
  state: CanvasState,
  kind: CanvasPanelKind,
  subjectId: string | null = null,
  viewport: CanvasViewport = DEFAULT_VIEWPORT
): CanvasState {
  const id = canvasPanelId(kind, subjectId)
  const existing = state.panels.find((panel) => panel.id === id)
  if (existing !== undefined) {
    // Re-opening a minimized panel expands it: the operator asked to see it.
    const opened = existing.minimized
      ? {
          ...state,
          panels: state.panels.map((panel) =>
            panel.id === id
              ? { ...panel, ...constrainRect(panel, viewport), minimized: false }
              : panel
          )
        }
      : state
    return raisePanel(opened, id)
  }

  const position = placePanel(state.panels, kind, viewport)
  const panel: CanvasPanel = {
    id,
    kind,
    subjectId: CANVAS_SINGLETONS[kind] ? null : subjectId,
    ...position,
    z: state.panels.length + 1,
    minimized: false
  }
  return { ...state, panels: normalizeZ([...state.panels, panel]) }
}

export function closePanel(state: CanvasState, id: string): CanvasState {
  return { ...state, panels: normalizeZ(state.panels.filter((panel) => panel.id !== id)) }
}

export function raisePanel(state: CanvasState, id: string): CanvasState {
  const target = state.panels.find((panel) => panel.id === id)
  if (target === undefined) return state
  // Already frontmost: skip, so a plain click does not churn the store.
  if (state.panels.every((panel) => panel.id === id || panel.z < target.z)) return state
  const raised = state.panels.map((panel) =>
    panel.id === id ? { ...panel, z: Number.MAX_SAFE_INTEGER } : panel
  )
  return { ...state, panels: normalizeZ(raised) }
}

/**
 * Re-map panel rectangles, keeping the original state object when none moved.
 *
 * Every caller persists on change, so a gesture that lands a panel where it
 * already was must not report a change and write the settings file.
 */
function constrainPanels(state: CanvasState, rectFor: (panel: CanvasPanel) => Rect): CanvasState {
  let changed = false
  const panels = state.panels.map((panel) => {
    const next = rectFor(panel)
    if (panel.x === next.x && panel.y === next.y && panel.w === next.w && panel.h === next.h) {
      return panel
    }
    changed = true
    return { ...panel, ...next }
  })
  return changed ? { ...state, panels } : state
}

export function setGeometry(
  state: CanvasState,
  id: string,
  rect: Rect,
  viewport: CanvasViewport
): CanvasState {
  return constrainPanels(state, (panel) =>
    panel.id === id ? constrainRect(rect, viewport, panel.minimized) : panel
  )
}

export function toggleMinimized(
  state: CanvasState,
  id: string,
  viewport: CanvasViewport
): CanvasState {
  const target = state.panels.find((panel) => panel.id === id)
  if (target === undefined) return state
  const minimized = !target.minimized
  return {
    ...state,
    panels: state.panels.map((panel) => {
      if (panel.id !== id) return panel
      return minimized
        ? { ...panel, minimized: true }
        : { ...panel, ...constrainRect(panel, viewport), minimized: false }
    })
  }
}

/** Pull every panel fully into the current viewport. */
export function clampToViewport(state: CanvasState, width: number, height: number): CanvasState {
  const viewport = { width, height }
  return constrainPanels(state, (panel) => constrainRect(panel, viewport, panel.minimized))
}

/** Snapshot the current arrangement under a name, replacing one of the same name. */
export function saveLayout(state: CanvasState, name: string, id = `layout-${Date.now()}`): CanvasState {
  const trimmed = name.trim()
  if (trimmed.length === 0) return state
  const layout: CanvasLayout = { id, name: trimmed, panels: state.panels.map((panel) => ({ ...panel })) }
  const existing = state.layouts.findIndex((item) => item.name.toLowerCase() === trimmed.toLowerCase())
  const layouts =
    existing >= 0
      ? state.layouts.map((item, index) => (index === existing ? { ...layout, id: item.id } : item))
      : [...state.layouts, layout]
  return { ...state, layouts, activeLayoutId: existing >= 0 ? state.layouts[existing].id : layout.id }
}

export function applyLayout(
  state: CanvasState,
  layoutId: string,
  viewport: CanvasViewport
): CanvasState {
  const layout = state.layouts.find((item) => item.id === layoutId)
  if (layout === undefined) return state
  const panels = layout.panels.map((panel) => ({
    ...panel,
    ...constrainRect(panel, viewport, panel.minimized)
  }))
  return { ...state, panels: normalizeZ(panels), activeLayoutId: layoutId }
}

export function initializeDefaultCanvas(
  state: CanvasState,
  width: number,
  height: number
): CanvasState {
  if (state.defaultLayoutVersion >= DEFAULT_CANVAS_LAYOUT_VERSION) return state
  if (state.panels.length > 0 || state.layouts.length > 0) {
    return { ...state, defaultLayoutVersion: DEFAULT_CANVAS_LAYOUT_VERSION }
  }
  return resetToCommandCentre(state, width, height)
}

export function resetToCommandCentre(
  state: CanvasState,
  width: number,
  height: number
): CanvasState {
  return clampToViewport(
    {
      ...state,
      panels: commandCentrePanels(width, height),
      activeLayoutId: null,
      defaultLayoutVersion: DEFAULT_CANVAS_LAYOUT_VERSION
    },
    width,
    height
  )
}

export function deleteLayout(state: CanvasState, layoutId: string): CanvasState {
  const layouts = state.layouts.filter((item) => item.id !== layoutId)
  return {
    ...state,
    layouts,
    activeLayoutId: state.activeLayoutId === layoutId ? null : state.activeLayoutId
  }
}
