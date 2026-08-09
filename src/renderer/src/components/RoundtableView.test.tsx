// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import React from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { RoundtableConfig } from '@shared/types'
import { RoundtableView } from './RoundtableView'
import { installApi, resetStore, roundtableFixture } from '../lib/testStubs'
import { useStore } from '../store/useStore'

Object.assign(globalThis, { React })

const usage = (inputTokens: number, outputTokens: number, costUsd: number | null) => ({
  inputTokens,
  outputTokens,
  costUsd
})

describe('RoundtableView live conversation', () => {
  beforeEach(() => {
    installApi()
    resetStore()
  })

  afterEach(() => cleanup())

  test('appends update turns and shows the next seat typing while running', async () => {
    const initial = roundtableFixture({ status: 'running' })
    let publishUpdate: ((cfg: RoundtableConfig) => void) | undefined
    installApi({
      listRoundtables: vi.fn().mockResolvedValue([initial]),
      onRoundtableUpdate: vi.fn((listener) => {
        publishUpdate = listener
        return vi.fn()
      })
    })
    resetStore({ roundtables: [initial], selectedRoundtableId: initial.id })

    await act(async () => {
      await useStore.getState().init()
    })
    render(<RoundtableView roundtableId={initial.id} />)

    expect(screen.getByText('Builder is typing…')).toBeInTheDocument()

    act(() => {
      publishUpdate?.({
        ...initial,
        turns: [
          {
            id: 'turn-1',
            seatId: 'seat-1',
            body: 'Ship the reversible option first.',
            createdAt: 1,
            usage: usage(120, 80, 0.12)
          }
        ],
        usage: usage(120, 80, 0.12)
      })
    })

    expect(screen.getByText('Ship the reversible option first.')).toBeInTheDocument()
    expect(screen.getByTestId('turn-turn-1')).toHaveAttribute('data-lane', 'left')
    expect(screen.getByText('Sceptic is typing…')).toBeInTheDocument()
    expect(screen.getByTestId('seat-cost-seat-1')).toHaveTextContent('$0.12')
  })

  test('renders alternating seat lanes and a prominent conclusion', () => {
    const concluded = roundtableFixture({
      status: 'concluded',
      conclusion: 'Use the reversible option, then measure adoption.',
      turns: [
        {
          id: 'turn-1',
          seatId: 'seat-1',
          body: 'Start small.',
          createdAt: 1,
          usage: usage(20, 10, 0.01)
        },
        {
          id: 'turn-2',
          seatId: 'seat-2',
          body: 'Add a rollback check.',
          createdAt: 2,
          usage: usage(30, 10, 0.02)
        }
      ],
      usage: usage(50, 20, 0.03)
    })
    resetStore({ roundtables: [concluded], selectedRoundtableId: concluded.id })

    render(<RoundtableView roundtableId={concluded.id} />)

    expect(screen.getByTestId('turn-turn-1')).toHaveAttribute('data-lane', 'left')
    expect(screen.getByTestId('turn-turn-2')).toHaveAttribute('data-lane', 'right')
    expect(screen.queryByText(/is typing/)).toBeNull()
    expect(screen.getByTestId('debate-conclusion')).toHaveTextContent(
      'Use the reversible option, then measure adoption.'
    )
  })

  test('does not present a partial seat cost when one turn has unknown pricing', () => {
    const debate = roundtableFixture({
      turns: [
        {
          id: 'turn-1',
          seatId: 'seat-1',
          body: 'Known-price turn.',
          createdAt: 1,
          usage: usage(20, 10, 0.01)
        },
        {
          id: 'turn-2',
          seatId: 'seat-1',
          body: 'Unknown-price turn.',
          createdAt: 2,
          usage: usage(30, 10, null)
        }
      ]
    })
    resetStore({ roundtables: [debate], selectedRoundtableId: debate.id })

    render(<RoundtableView roundtableId={debate.id} />)

    expect(screen.getByTestId('seat-cost-seat-1')).toHaveTextContent('70 tok')
    expect(screen.getByTestId('seat-cost-seat-1')).not.toHaveTextContent('$')
  })
})
