// Tiny hash-based router. No dependency: the four top-level destinations plus a
// `workers/:id` detail route are encoded in `location.hash` so back/forward and
// deep links work on a phone, and so the core can serve one static index.html.

import { useEffect, useState } from 'react'

export type Route =
  | { name: 'timeline' }
  | { name: 'workers' }
  | { name: 'worker'; workerId: string }
  | { name: 'automations' }
  | { name: 'review' }

/** Parse `#/workers/abc` → `{ name: 'worker', workerId: 'abc' }`. */
export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '')
  const [head, ...rest] = raw.split('/')
  switch (head) {
    case 'workers':
      return { name: 'workers' }
    case 'worker': {
      const workerId = decodeURIComponent(rest.join('/') ?? '')
      return workerId ? { name: 'worker', workerId } : { name: 'workers' }
    }
    case 'automations':
      return { name: 'automations' }
    case 'review':
      return { name: 'review' }
    default:
      return { name: 'timeline' }
  }
}

export function routeToHash(route: Route): string {
  switch (route.name) {
    case 'worker':
      return `#/worker/${encodeURIComponent(route.workerId)}`
    default:
      return `#/${route.name}`
  }
}

/** Subscribe to the hash; expose a setter that updates history without scrolling. */
export function useRoute(): [Route, (route: Route) => void] {
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash))

  useEffect(() => {
    const onChange = (): void => setRoute(parseHash(location.hash))
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  const navigate = (next: Route): void => {
    const hash = routeToHash(next)
    if (hash === location.hash) return
    location.hash = hash
  }

  return [route, navigate]
}
