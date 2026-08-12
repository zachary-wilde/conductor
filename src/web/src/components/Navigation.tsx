// Navigation: a bottom tab bar on phones and a vertical rail on wide screens.
// Both are driven by the same route + navigate props so there is one source of
// truth for which screen is active (the `workers` tab stays active on a worker
// detail route).

import { Activity, Clock, Cpu, GitPullRequest, Smartphone } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { Route } from '../state/router'

interface NavItem {
  route: Route
  label: string
  Icon: LucideIcon
}

const NAV: NavItem[] = [
  { route: { name: 'timeline' }, label: 'Timeline', Icon: Activity },
  { route: { name: 'workers' }, label: 'Workers', Icon: Cpu },
  { route: { name: 'automations' }, label: 'Automations', Icon: Clock },
  { route: { name: 'review' }, label: 'Review', Icon: GitPullRequest },
  { route: { name: 'runtime' }, label: 'This tablet', Icon: Smartphone }
]

function tabActive(current: Route, item: NavItem): boolean {
  const target = item.route.name
  if (target === 'workers') return current.name === 'workers' || current.name === 'worker'
  return current.name === target
}

export function BottomNav({
  route,
  navigate
}: {
  route: Route
  navigate: (r: Route) => void
}): JSX.Element {
  return (
    <nav
      aria-label="Mobile navigation"
      className="flex border-t border-edge bg-bg-1 pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      {NAV.map((item) => {
        const active = tabActive(route, item)
        return (
          <button
            key={item.label}
            onClick={() => navigate(item.route)}
            aria-current={active ? 'page' : undefined}
            className={`flex min-h-11 flex-1 flex-col items-center justify-center gap-1 py-2.5 text-[10px] font-medium transition-colors ${
              active ? 'text-accent' : 'text-text-low'
            }`}
          >
            <item.Icon size={20} />
            {item.label}
          </button>
        )
      })}
    </nav>
  )
}

export function SideRail({
  route,
  navigate
}: {
  route: Route
  navigate: (r: Route) => void
}): JSX.Element {
  return (
    <nav
      aria-label="Tablet navigation"
      className="hidden w-52 shrink-0 flex-col gap-1 border-r border-edge bg-bg-1 p-3 md:flex"
    >
      <div className="mb-3 flex items-center gap-2 px-2 py-2">
        <Activity size={16} className="text-accent" />
        <span className="text-sm font-semibold tracking-tight text-text-hi">Reigen</span>
      </div>
      {NAV.map((item) => {
        const active = tabActive(route, item)
        return (
          <button
            key={item.label}
            onClick={() => navigate(item.route)}
            aria-current={active ? 'page' : undefined}
            className={`flex min-h-11 items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
              active
                ? 'bg-bg-3 text-text-hi'
                : 'text-text-low hover:bg-bg-2 hover:text-text-mid'
            }`}
          >
            <item.Icon size={16} />
            {item.label}
          </button>
        )
      })}
    </nav>
  )
}
