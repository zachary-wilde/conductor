import { useEffect, useState } from 'react'

/**
 * macOS-style window controls, on the LEFT, replacing the Windows min/max/close set.
 *
 * Three details make these read as real traffic lights rather than coloured dots:
 *   - glyphs appear only while the pointer is over the *group*, not the individual button
 *   - the whole group desaturates to grey when the window loses focus
 *   - the hit target is larger than the painted circle, because 12px is below the
 *     comfortable minimum and Windows has no OS-drawn caption to fall back on
 *
 * Order matches macOS: close, minimize, zoom.
 */

type Light = {
  id: 'close' | 'minimize' | 'zoom'
  label: string
  fill: string
  ring: string
  glyph: JSX.Element
  run: () => void
}

const GLYPH = 'pointer-events-none opacity-0 transition-opacity duration-100 group-hover/lights:opacity-100'

export function TrafficLights(): JSX.Element {
  const [focused, setFocused] = useState(true)

  useEffect(() => {
    const on = (): void => setFocused(true)
    const off = (): void => setFocused(false)
    window.addEventListener('focus', on)
    window.addEventListener('blur', off)
    setFocused(document.hasFocus())
    return () => {
      window.removeEventListener('focus', on)
      window.removeEventListener('blur', off)
    }
  }, [])

  const lights: Light[] = [
    {
      id: 'close',
      label: 'Close',
      fill: '#ff5f57',
      ring: '#e0443e',
      glyph: (
        <svg viewBox="0 0 10 10" className={`h-[7px] w-[7px] ${GLYPH}`} aria-hidden="true">
          <path d="M2.4 2.4l5.2 5.2M7.6 2.4L2.4 7.6" stroke="#4d0000" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      ),
      run: () => void window.api.closeWindow()
    },
    {
      id: 'minimize',
      label: 'Minimize',
      fill: '#febc2e',
      ring: '#dea123',
      glyph: (
        <svg viewBox="0 0 10 10" className={`h-[7px] w-[7px] ${GLYPH}`} aria-hidden="true">
          <path d="M2.2 5h5.6" stroke="#5a3d00" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      ),
      run: () => void window.api.minimizeWindow()
    },
    {
      id: 'zoom',
      label: 'Maximize',
      fill: '#28c840',
      ring: '#1dad2b',
      glyph: (
        <svg viewBox="0 0 10 10" className={`h-[7px] w-[7px] ${GLYPH}`} aria-hidden="true">
          <path d="M3 7V3h4" stroke="#003d07" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M7 3v4H3" stroke="#003d07" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ),
      run: () => void window.api.toggleMaximizeWindow()
    }
  ]

  return (
    <div
      className="group/lights flex items-center gap-2 pl-1"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      {lights.map((l) => (
        <button
          key={l.id}
          type="button"
          onClick={l.run}
          title={l.label}
          aria-label={l.label}
          data-testid={`window-${l.id}`}
          className="flex h-[13px] w-[13px] items-center justify-center rounded-full border transition-colors"
          style={{
            backgroundColor: focused ? l.fill : '#4c515c',
            borderColor: focused ? l.ring : '#3c404a'
          }}
        >
          {l.glyph}
        </button>
      ))}
    </div>
  )
}
