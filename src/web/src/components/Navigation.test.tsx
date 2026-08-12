// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { SideRail } from './Navigation'

Object.assign(globalThis, { React })

afterEach(() => cleanup())

test('uses the Reigen public identity in the tablet rail', () => {
  render(<SideRail route={{ name: 'timeline' }} navigate={() => undefined} />)

  const rail = screen.getByRole('navigation', { name: 'Tablet navigation' })
  expect(within(rail).getByText('Reigen')).toBeInTheDocument()
  expect(within(rail).getByRole('button', { name: 'Timeline' })).toHaveClass('min-h-11')
})
