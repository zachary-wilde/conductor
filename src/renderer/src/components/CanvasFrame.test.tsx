// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { CanvasPanel } from '@shared/types'
import { CanvasFrame } from './CanvasFrame'

Object.assign(globalThis, { React })

const panel: CanvasPanel = {
  id: 'sessions',
  kind: 'sessions',
  subjectId: null,
  x: 100,
  y: 80,
  w: 300,
  h: 200,
  z: 1,
  minimized: false
}

function renderFrame(onGeometry = vi.fn()): typeof onGeometry {
  render(
    <CanvasFrame
      panel={panel}
      viewport={{ width: 800, height: 600 }}
      title="Sessions"
      active
      onGeometry={onGeometry}
      onRaise={vi.fn()}
      onMinimize={vi.fn()}
      onClose={vi.fn()}
    >
      body
    </CanvasFrame>
  )
  return onGeometry
}

afterEach(cleanup)

describe('CanvasFrame containment', () => {
  test('a live drag stops with the complete panel at the bottom-right edge', () => {
    const onGeometry = renderFrame()
    const header = screen.getByText('Sessions').closest('header')!

    fireEvent.mouseDown(header, { button: 0, clientX: 120, clientY: 100 })
    act(() => {
      document.dispatchEvent(
        new MouseEvent('mousemove', { clientX: 2000, clientY: 2000 })
      )
    })

    expect(screen.getByTestId('canvas-panel')).toHaveStyle({ left: '500px', top: '400px' })

    act(() => document.dispatchEvent(new MouseEvent('mouseup')))
    expect(onGeometry).toHaveBeenCalledWith({ x: 500, y: 400, w: 300, h: 200 })
  })

  test('a live east resize stops at the right canvas edge', () => {
    const onGeometry = renderFrame()
    const handle = screen.getByRole('separator', { name: 'Resize Sessions e' })

    fireEvent.mouseDown(handle, { button: 0, clientX: 400, clientY: 180 })
    act(() => {
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 2000, clientY: 180 }))
    })

    expect(screen.getByTestId('canvas-panel')).toHaveStyle({ left: '100px', width: '700px' })

    act(() => document.dispatchEvent(new MouseEvent('mouseup')))
    expect(onGeometry).toHaveBeenCalledWith({ x: 100, y: 80, w: 700, h: 200 })
  })
})
