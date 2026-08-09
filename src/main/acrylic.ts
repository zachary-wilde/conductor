import { release } from 'node:os'
import type { BrowserWindow } from 'electron'

/**
 * Real translucency for the window itself, so surfaces blur what is *behind
 * Conductor* rather than just its own pixels.
 *
 * Windows 11 22H2+ exposes this properly through Electron's `backgroundMaterial`.
 * Windows 10 has no supported API, so we fall back to the undocumented
 * `SetWindowCompositionAttribute` blur-behind that Fluent shipped on 1803+.
 * Anything else (or any failure) degrades to the in-app treatment, which still
 * looks intentional — it just does not sample the desktop.
 */
export type AcrylicMode =
  | 'native'
  | 'acrylic-blur-behind'
  | 'blur-behind'
  | 'blur-classic'
  /** Translucency was successfully turned OFF. Not a failure — see 'unsupported'. */
  | 'disabled'
  | 'unsupported'

const ACCENT_DISABLED = 0
const ACCENT_ENABLE_BLURBEHIND = 3
const ACCENT_ENABLE_ACRYLICBLURBEHIND = 4
const WCA_ACCENT_POLICY = 19
/**
 * The BGR half of the composition tint (AABBGGRR); the alpha half comes from the
 * user's acrylic-intensity setting via `acrylicTint`.
 */
const TINT_BGR = 0x101014

/**
 * Intensity is "how much glass": 100 = no tint at all, pure blur; 0 = an opaque
 * plate. It maps straight onto the tint's alpha byte, and the default setting of
 * 71 reproduces 0x4a — 29% opaque, matched to Windows Terminal's `"opacity": 29`,
 * which is the value this effect was tuned at. The previous 0xb0 (69%) was heavy
 * enough to mute the blur into a flat dark scrim, which is why it read as tint
 * rather than acrylic.
 */
export function acrylicTint(intensity: number): number {
  const clamped = Math.min(100, Math.max(0, Number.isFinite(intensity) ? intensity : 71))
  const alpha = Math.round(255 * (1 - clamped / 100))
  // >>> 0 keeps the result an unsigned 32-bit value; << 24 on alpha >= 128
  // would otherwise produce a negative number and koffi would reject it.
  return ((alpha << 24) | TINT_BGR) >>> 0
}

function windowsBuild(): number {
  const build = Number(release().split('.')[2])
  return Number.isFinite(build) ? build : 0
}

interface CompositionBinding {
  /** Returns the BOOL from SetWindowCompositionAttribute; 0 means Windows refused. */
  set: (hwnd: bigint, accentState: number, tint: number) => boolean
}

let binding: CompositionBinding | null | undefined

/** Bound lazily: koffi only loads on Windows 10, and never in tests. */
function compositionBinding(): CompositionBinding | null {
  if (binding !== undefined) return binding
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require('koffi')
    const user32 = koffi.load('user32.dll')
    const accentPolicy = koffi.struct('ACCENT_POLICY', {
      AccentState: 'uint32',
      AccentFlags: 'uint32',
      GradientColor: 'uint32',
      AnimationId: 'uint32'
    })
    const attributeData = koffi.struct('WINCOMPATTRDATA', {
      Attribute: 'uint32',
      pData: 'void*',
      cbData: 'size_t'
    })
    const setAttribute = user32.func(
      'int __stdcall SetWindowCompositionAttribute(uint64 hwnd, WINCOMPATTRDATA* data)'
    )
    binding = {
      set: (hwnd, accentState, tint) => {
        const policy = koffi.alloc(accentPolicy, 1)
        koffi.encode(policy, accentPolicy, {
          AccentState: accentState,
          AccentFlags: 2,
          GradientColor: accentState === ACCENT_DISABLED ? 0 : tint,
          AnimationId: 0
        })
        const data = koffi.alloc(attributeData, 1)
        koffi.encode(data, attributeData, {
          Attribute: WCA_ACCENT_POLICY,
          pData: policy,
          cbData: koffi.sizeof(accentPolicy)
        })
        return setAttribute(hwnd, data) !== 0
      }
    }
  } catch {
    binding = null
  }
  return binding
}

/**
 * `intensity` is the user's acrylic-intensity setting (0-100). On Win10 it becomes the
 * composition tint's alpha; on Win11's native `backgroundMaterial` there is no tint
 * knob, so the renderer's CSS is the only lever and this argument is ignored.
 *
 * `preferClassic` downgrades Win10 to ACCENT_ENABLE_BLURBEHIND (3). State 4 (acrylic)
 * is the richer effect but DWM does not composite it efficiently during a native
 * move/resize loop on Win10 1903+, which shows up as several frames of lag and a ghost
 * cursor. Callers drop to 3 for the duration of the gesture and back to 4 after.
 */
export function applyWindowAcrylic(
  window: BrowserWindow,
  enabled: boolean,
  intensity: number,
  preferClassic = false
): AcrylicMode {
  if (process.platform !== 'win32') return 'unsupported'
  const build = windowsBuild()

  if (build >= 22621) {
    try {
      window.setBackgroundMaterial(enabled ? 'acrylic' : 'none')
      return 'native'
    } catch {
      // Fall through to the legacy path rather than losing the effect entirely.
    }
  }

  if (build >= 17134) {
    const composition = compositionBinding()
    if (composition) {
      try {
        // The Buffer *contains* the HWND; passing the Buffer would hand Windows
        // the address of our buffer instead of the window handle.
        const handleBuffer = window.getNativeWindowHandle()
        const hwnd = handleBuffer.length >= 8 ? handleBuffer.readBigUInt64LE(0) : BigInt(handleBuffer.readUInt32LE(0))
        if (!enabled) {
          composition.set(hwnd, ACCENT_DISABLED, 0)
          return 'disabled'
        }
        const tint = acrylicTint(intensity)
        // Acrylic blur-behind is the richer effect but Windows silently refuses
        // it on some builds; plain blur-behind is the compatible fallback.
        if (preferClassic) {
          return composition.set(hwnd, ACCENT_ENABLE_BLURBEHIND, tint) ? 'blur-classic' : 'unsupported'
        }
        if (composition.set(hwnd, ACCENT_ENABLE_ACRYLICBLURBEHIND, tint)) return 'acrylic-blur-behind'
        if (composition.set(hwnd, ACCENT_ENABLE_BLURBEHIND, tint)) return 'blur-classic'
        return 'unsupported'
      } catch {
        return 'unsupported'
      }
    }
  }

  return 'unsupported'
}
