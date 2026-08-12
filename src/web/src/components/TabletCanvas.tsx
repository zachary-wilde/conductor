import { createContext, useCallback, useContext, useState } from 'react'
import type { ReactNode } from 'react'
import type { Route } from '../state/router'
import { BottomNav, SideRail } from './Navigation'
import { RateLimitBanner } from './RateLimitBanner'
import { TopBar } from './TopBar'

const TabletCanvasOverlayContext = createContext<HTMLElement | null>(null)

export function useTabletCanvasOverlay(): HTMLElement | null {
  return useContext(TabletCanvasOverlayContext)
}

/**
 * Shared route canvas for the web operator. The same route content is hosted by
 * a Windows-inspired rail on tablet-sized screens and by the compact bottom
 * navigation on phones; navigation remains driven by the hash router.
 */
export function TabletCanvas({
  route,
  navigate,
  children
}: {
  route: Route
  navigate: (route: Route) => void
  children: ReactNode
}): JSX.Element {
  const [overlayTarget, setOverlayTargetState] = useState<HTMLDivElement | null>(null)
  const setOverlayTarget = useCallback((element: HTMLDivElement | null): void => {
    setOverlayTargetState(element)
  }, [])

  return (
    <TabletCanvasOverlayContext.Provider value={overlayTarget}>
      <div className="tablet-canvas-shell flex h-full min-h-0 flex-col-reverse md:flex-row">
        <BottomNav route={route} navigate={navigate} />
        <SideRail route={route} navigate={navigate} />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <TopBar />
          <RateLimitBanner />
          <div className="tablet-canvas-content flex min-h-0 flex-1 flex-col">
            <div className="tablet-canvas-surface relative isolate flex min-h-0 flex-1 flex-col overflow-hidden">
              {children}
              <div ref={setOverlayTarget} className="pointer-events-none absolute inset-0 z-20" data-testid="tablet-canvas-overlay" />
            </div>
          </div>
        </main>
      </div>
    </TabletCanvasOverlayContext.Provider>
  )
}
