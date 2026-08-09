// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { installApi, resetStore } from '../lib/testStubs'
import { CoreStatusBanner } from './CoreStatusBanner'

Object.assign(globalThis, { React })

beforeEach(() => {
  installApi()
  resetStore()
})

afterEach(cleanup)

describe('CoreStatusBanner diagnostics', () => {
  test('shows the log path and opens it from an unavailable Core detail', () => {
    const logPath = 'D:/Conductor/conductor-data/v2/logs/core.log'
    resetStore({
      coreStatus: {
        state: 'error',
        detail: `Core log: ${logPath}\nCore exit code: 1\nLast log lines:\n[core] failed to boot`
      }
    })

    render(<CoreStatusBanner />)
    expect(screen.getByText(`Core log: ${logPath}`)).toBeInTheDocument()
    expect(screen.getByText(/Core exit code: 1/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /open logs/i }))

    expect(window.api.openPath).toHaveBeenCalledWith(logPath)
  })

  test('keeps the pure banner copy independent from diagnostics', () => {
    resetStore({ coreStatus: { state: 'error', detail: 'Core log: D:/core.log' } })
    render(<CoreStatusBanner />)

    expect(screen.getByText('Conductor Core unavailable — retrying…')).toBeInTheDocument()
    expect(vi.mocked(window.api.openPath)).not.toHaveBeenCalled()
  })
})
