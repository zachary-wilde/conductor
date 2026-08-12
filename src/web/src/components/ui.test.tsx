// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import React from 'react'
import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import { Badge, Button } from './ui'

Object.assign(globalThis, { React })

test('shared status badge exposes semantic state for both web shells', () => {
  render(<Badge tone="success">Connected</Badge>)

  expect(screen.getByText('Connected')).toHaveAttribute('data-tone', 'success')
})

test('shared buttons expose tablet touch sizing', () => {
  render(<Button>Continue</Button>)

  expect(screen.getByRole('button', { name: 'Continue' })).toHaveClass('min-h-11')
})
