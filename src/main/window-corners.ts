import { screen, type BrowserWindow } from 'electron'
import { release } from 'node:os'

/**
 * Rounded window corners on Windows.
 *
 * Windows 11 rounds frameless windows itself once asked, and does it with proper
 * anti-aliasing. Windows 10 does not round anything and has no API for it, so the
 * only way is to clip the window's region to a rounded rectangle — which also
 * clips the DWM acrylic behind it, and is therefore the only approach that does
 * not leave four squares of blur poking out past the corners.
 *
 * `SetWindowRgn` has no anti-aliasing, so the region is cut one pixel wider than
 * the CSS radius the renderer paints; the smooth CSS edge then sits just inside
 * the hard region edge and hides the stair-stepping.
 */

/** Matches `--window-radius` in index.css. Changing one without the other shows a seam. */
export const WINDOW_CORNER_RADIUS = 10

const DWMWA_WINDOW_CORNER_PREFERENCE = 33
const DWMWCP_ROUND = 2
/** Windows 11 21H2. Below this, DwmSetWindowAttribute(33) is silently ignored. */
const WIN11_BUILD = 22000

export type CornerMode = 'native' | 'region' | 'unsupported'

interface CornerBinding {
  /** Win11: ask DWM. Returns false when the call was refused. */
  setPreference: (hwnd: bigint) => boolean
  /** Win10: clip the window region. Width/height are in physical pixels. */
  setRegion: (hwnd: bigint, width: number, height: number) => boolean
  clearRegion: (hwnd: bigint) => void
}

let binding: CornerBinding | null | undefined

function windowsBuild(): number {
  const build = Number(release().split('.')[2])
  return Number.isFinite(build) ? build : 0
}

/** Bound lazily: koffi only loads on Windows, and never in tests. */
function cornerBinding(): CornerBinding | null {
  if (binding !== undefined) return binding
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require('koffi')
    const user32 = koffi.load('user32.dll')
    const gdi32 = koffi.load('gdi32.dll')
    const dwmapi = koffi.load('dwmapi.dll')

    const setWindowRgn = user32.func('int __stdcall SetWindowRgn(uint64 hwnd, uint64 hrgn, int redraw)')
    const createRoundRectRgn = gdi32.func(
      'uint64 __stdcall CreateRoundRectRgn(int left, int top, int right, int bottom, int w, int h)'
    )
    const dwmSetWindowAttribute = dwmapi.func(
      'int __stdcall DwmSetWindowAttribute(uint64 hwnd, uint32 attr, void* value, uint32 size)'
    )

    binding = {
      setPreference: (hwnd) => {
        const value = koffi.alloc('uint32', 1)
        koffi.encode(value, 'uint32', DWMWCP_ROUND)
        // S_OK is 0; anything else means the build does not know this attribute.
        return dwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, value, 4) === 0
      },
      setRegion: (hwnd, width, height) => {
        // +1 on the far edges: CreateRoundRectRgn's bottom-right bound is
        // exclusive, so without it the last row and column are clipped away.
        const region = createRoundRectRgn(
          0,
          0,
          width + 1,
          height + 1,
          WINDOW_CORNER_RADIUS * 2,
          WINDOW_CORNER_RADIUS * 2
        )
        if (region === 0n) return false
        // Ownership of the region passes to the window; it must not be deleted here.
        return setWindowRgn(hwnd, region, 1) !== 0
      },
      clearRegion: (hwnd) => {
        setWindowRgn(hwnd, 0n, 1)
      }
    }
  } catch {
    binding = null
  }
  return binding
}

function handleOf(window: BrowserWindow): bigint | null {
  try {
    const buffer = window.getNativeWindowHandle()
    return buffer.length >= 8 ? buffer.readBigUInt64LE(0) : BigInt(buffer.readUInt32LE(0))
  } catch {
    return null
  }
}

/**
 * Round the window's corners, and keep them rounded.
 *
 * On the Win10 region path this must run again after every resize, because a
 * region is a fixed pixel shape rather than a rule — a resized window would
 * otherwise be clipped to its old size. A MAXIMIZED window is squared off again
 * deliberately: Windows expects a maximized window to fill the work area, and
 * rounded corners there just leak the desktop at the screen edges.
 */
export function applyWindowCorners(window: BrowserWindow): CornerMode {
  if (process.platform !== 'win32') return 'unsupported'
  const hwnd = handleOf(window)
  const corners = cornerBinding()
  if (hwnd === null || corners === null) return 'unsupported'

  if (windowsBuild() >= WIN11_BUILD && corners.setPreference(hwnd)) return 'native'

  if (window.isMaximized() || window.isFullScreen()) {
    corners.clearRegion(hwnd)
    return 'region'
  }
  // getBounds is in device-independent pixels; a region is in physical ones, so
  // on a scaled display the two disagree and the clip lands short.
  const bounds = window.getBounds()
  const { scaleFactor } = screen.getDisplayMatching(bounds)
  const width = Math.round(bounds.width * scaleFactor)
  const height = Math.round(bounds.height * scaleFactor)
  return corners.setRegion(hwnd, width, height) ? 'region' : 'unsupported'
}
