// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { installApi, resetStore } from '../lib/testStubs'
import { StoreRecoveryPanel } from './StoreRecoveryPanel'

Object.assign(globalThis, { React })

beforeEach(() => {
  installApi()
  resetStore()
})

afterEach(cleanup)

describe('StoreRecoveryPanel', () => {
  test('shows reset, export, and import recovery actions for a load error', () => {
    resetStore({ storeLoadError: 'failed to load store: unexpected token' })
    render(<StoreRecoveryPanel />)

    expect(screen.getByRole('alert')).toHaveTextContent('unexpected token')
    expect(screen.getByRole('button', { name: /reset store/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /export/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /import/i })).toBeInTheDocument()
  })
})
