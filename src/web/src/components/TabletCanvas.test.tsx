// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { TabletCanvas } from './TabletCanvas'
import type { Route } from '../state/router'

Object.assign(globalThis, { React })

vi.mock('../state/coreContext', () => ({
  useCore: () => ({
    handshake: { coreVersion: '1.0.0' },
    compatible: true,
    apiBase: 'https://core.example.test',
    apiToken: '',
    openConnect: vi.fn()
  })
}))

vi.mock('../state/timeline', () => ({
  connectionStatusOf: () => 'connected',
  useTimeline: () => ({
    status: 'live',
    state: { events: [] },
    rateLimit: null,
    clearRateLimit: vi.fn()
  })
}))

afterEach(() => cleanup())

beforeEach(() => {
  window.location.hash = '#/workers'
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 })
})

function renderRoute(route: Route) {
  const navigate = vi.fn()
  render(
    <TabletCanvas route={route} navigate={navigate}>
      <article aria-label={`${route.name} content card`}>
        <h1>{route.name === 'worker' ? `Worker ${route.workerId}` : route.name}</h1>
      </article>
    </TabletCanvas>
  )
  return navigate
}

test('tablet viewport exposes top chrome, active side navigation, and routed canvas content', () => {
  const navigate = renderRoute({ name: 'workers' })

  expect(screen.getByRole('banner')).toBeInTheDocument()
  const rail = screen.getByRole('navigation', { name: 'Tablet navigation' })
  expect(within(rail).getByRole('button', { name: 'Workers' })).toHaveAttribute(
    'aria-current',
    'page'
  )
  expect(screen.getByRole('article', { name: 'workers content card' })).toBeInTheDocument()

  expect(screen.getByTestId('tablet-canvas-overlay')).toBeInTheDocument()

  fireEvent.click(within(rail).getByRole('button', { name: 'Review' }))
  expect(navigate).toHaveBeenCalledWith({ name: 'review' })
})

test('narrow viewport retains bottom navigation and worker detail route semantics', () => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
  const navigate = renderRoute({ name: 'worker', workerId: 'worker-7' })

  const bottomNav = screen.getByRole('navigation', { name: 'Mobile navigation' })
  expect(within(bottomNav).getByRole('button', { name: 'Workers' })).toHaveAttribute(
    'aria-current',
    'page'
  )
  expect(screen.getByRole('article', { name: 'worker content card' })).toHaveTextContent('Worker worker-7')

  fireEvent.click(within(bottomNav).getByRole('button', { name: 'Workers' }))
  expect(navigate).toHaveBeenCalledWith({ name: 'workers' })
})
