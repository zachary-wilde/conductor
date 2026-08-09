// Operator web app shell. Boots the core connection (handshake gate), and once
// a compatible core is reachable mounts the shared live timeline and routes
// between the four screens. Mobile renders a bottom tab bar; wide screens
// render a left rail. The shell never issues a command before the handshake
// reports a compatible protocol. The Connect dialog overlays every state: it
// opens automatically on a failed handshake (incl. a 401) and is re-openable
// from the TopBar to retarget the core / change the token.

import { CoreProvider, useCore } from './state/coreContext'
import { TimelineProvider } from './state/timeline'
import { useRoute } from './state/router'
import type { Route } from './state/router'
import { BottomNav, SideRail } from './components/Navigation'
import { TopBar } from './components/TopBar'
import { RateLimitBanner } from './components/RateLimitBanner'
import { ConnectScreen } from './components/ConnectScreen'
import { TimelineView } from './views/TimelineView'
import { WorkersView } from './views/WorkersView'
import { WorkerDetailView } from './views/WorkerDetailView'
import { AutomationsView } from './views/AutomationsView'
import { ReviewView } from './views/ReviewView'
import { Spinner } from './components/ui'
import type { ReactNode } from 'react'

export function App(): JSX.Element {
  return (
    <CoreProvider>
      <Shell />
    </CoreProvider>
  )
}

function Shell(): JSX.Element {
  const { client, booting, handshake, apiBase } = useCore()

  return (
    <>
      {handshake ? (
        <TimelineProvider client={client}>
          <ShellLayout />
        </TimelineProvider>
      ) : (
        <BootScreen booting={booting} apiBase={apiBase} />
      )}
      {/* Overlays every state: auto-pinned on a boot error, dismissible once a
          core is connected. The dialog itself decides what it renders. */}
      <ConnectScreen />
    </>
  )
}

/** Placeholder behind the Connect dialog while there is no usable core. */
function BootScreen({ booting, apiBase }: { booting: boolean; apiBase: string }): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-text-low">
      {booting ? (
        <>
          <Spinner className="h-6 w-6" />
          <p className="text-sm">connecting to core…</p>
        </>
      ) : (
        <p className="text-sm font-medium text-[rgb(var(--danger))]">core unreachable</p>
      )}
      <p className="font-mono text-[10px] text-text-hint">{apiBase}</p>
    </div>
  )
}

function ShellLayout(): JSX.Element {
  const [route, navigate] = useRoute()
  return (
    <div className="flex h-full flex-col-reverse md:flex-row">
      <BottomNav route={route} navigate={navigate} />
      <SideRail route={route} navigate={navigate} />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <TopBar />
        <RateLimitBanner />
        <div className="flex min-h-0 flex-1 flex-col">{renderView(route, navigate)}</div>
      </main>
    </div>
  )
}

/** Centered, scrolling column for the form/list screens (timeline scrolls itself). */
function ViewScroll({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="scroll-thin mx-auto flex w-full max-w-3xl flex-1 flex-col overflow-y-auto px-4 py-4 md:px-6 md:py-6">
      {children}
    </div>
  )
}

function renderView(route: Route, navigate: (r: Route) => void): JSX.Element {
  switch (route.name) {
    case 'timeline':
      return <TimelineView />
    case 'workers':
      return (
        <ViewScroll>
          <h1 className="text-sm font-semibold text-text-hi">Workers</h1>
          <WorkersView navigate={navigate} />
        </ViewScroll>
      )
    case 'worker':
      return (
        <ViewScroll>
          <WorkerDetailView
            workerId={route.workerId}
            onBack={() => navigate({ name: 'workers' })}
          />
        </ViewScroll>
      )
    case 'automations':
      return (
        <ViewScroll>
          <AutomationsView />
        </ViewScroll>
      )
    case 'review':
      return (
        <ViewScroll>
          <ReviewView />
        </ViewScroll>
      )
  }
}
