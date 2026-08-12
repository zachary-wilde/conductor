// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { HARNESS_INFO } from '@shared/types'
import type { HarnessAvailability } from '@shared/types'
import { installApi, resetStore } from '../lib/testStubs'
import { NewRavelModal } from './NewRavelModal'

Object.assign(globalThis, { React })

const REPO = { id: 'repo-1', path: 'D:/repo', name: 'repo', addedAt: 1 }

function harness(id: HarnessAvailability['id'], available: boolean): HarnessAvailability {
  return { id, info: HARNESS_INFO[id], available }
}

beforeEach(() => {
  installApi()
  resetStore({ repos: [REPO], harnesses: [harness('claude', true)] })
})

afterEach(cleanup)

describe('NewRavelModal creation contract', () => {
  test('creates Reigen without user-configurable name or child limit', async () => {
    const user = userEvent.setup()
    render(<NewRavelModal />)

    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument()
    expect(screen.queryByText('Max children')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /create reigen/i }))

    expect(window.api.createRavel).toHaveBeenCalledWith(
      expect.not.objectContaining({ maxChildren: expect.anything() })
    )
    expect(window.api.createRavel).toHaveBeenCalledWith(
      expect.not.objectContaining({ name: expect.anything() })
    )
    expect(window.api.createRavel).toHaveBeenCalledWith(
      expect.objectContaining({ repoId: 'repo-1', repoPath: 'D:/repo', harness: 'claude', allowRisky: false })
    )
  })

  test('enabling autonomy creates Reigen with allowRisky true', async () => {
    const user = userEvent.setup()
    render(<NewRavelModal />)

    await user.click(screen.getByTestId('ravel-allow-risky'))
    await user.click(screen.getByRole('button', { name: /create reigen/i }))

    expect(window.api.createRavel).toHaveBeenCalledWith(
      expect.objectContaining({ allowRisky: true })
    )
  })
})
