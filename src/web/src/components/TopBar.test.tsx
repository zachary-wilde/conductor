// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { TopBar } from './TopBar'

Object.assign(globalThis, { React })

vi.mock('../state/coreContext', () => ({
  useCore: () => ({
    handshake: { coreVersion: '1.0.0' },
    compatible: true,
    apiBase: 'https://core.example.test',
    apiToken: 'token',
    openConnect: vi.fn()
  })
}))

vi.mock('../state/timeline', () => ({
  connectionStatusOf: () => 'connected',
  useTimeline: () => ({ status: 'live' })
}))

afterEach(() => cleanup())

test('uses the Reigen public identity and touch-sized connection control', () => {
  render(<TopBar />)

  expect(screen.getByText('Reigen')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Connection settings' })).toHaveClass('min-h-11')
})
