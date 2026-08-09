import { ViewMenu } from './ViewMenu'
import { TrafficLights } from './TrafficLights'

/**
 * The window is frameless on Windows so it can be genuinely translucent, which
 * means the app owns dragging and the window controls.
 *
 * The controls are macOS traffic lights on the LEFT rather than the Windows set on
 * the right. That is a deliberate cosmetic choice, not an oversight: Alt+F4, Aero
 * Snap, Win+Arrow and the taskbar are unaffected because they are handled by the OS
 * against the HWND, not by these buttons.
 *
 * Double-click toggles maximize. Without it a maximized window was effectively
 * stuck: `-webkit-app-region: drag` does nothing while maximized, and the only
 * way back was finding the 13px green light.
 */
export function TitleBar(): JSX.Element {
  return (
    <div
      className="flex h-9 shrink-0 items-center justify-between px-3 text-text-low"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      onDoubleClick={() => void window.api.toggleMaximizeWindow()}
    >
      <div className="flex items-center gap-3">
        <TrafficLights />
        <span className="select-none text-[12px] font-medium tracking-[0.01em] text-text">
          Conductor
        </span>
      </div>
      <div
        className="flex items-center gap-1.5"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <ViewMenu />
      </div>
    </div>
  )
}
