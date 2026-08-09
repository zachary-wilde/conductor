import { describe, it, expect } from 'vitest'
import {
  encodeFrame,
  decodeFrames,
  isEvent,
  isRequest,
  isResponse,
  type ControlFrame,
  type ControlRequest,
  type ControlResponse,
  type ControlEvent
} from './control-protocol'

describe('control protocol framing', () => {
  it('round-trips a frame through encode/decode', () => {
    const req: ControlRequest = { id: 1, method: 'session.list', args: [] }
    const { frames, rest } = decodeFrames('', encodeFrame(req))
    expect(rest).toBe('')
    expect(frames).toEqual([req])
  })

  it('reassembles a frame split across chunks', () => {
    const resp: ControlResponse = { id: 7, ok: true, value: { a: 1 } }
    const wire = encodeFrame(resp)
    const cut = Math.floor(wire.length / 2)
    const first = decodeFrames('', wire.slice(0, cut))
    expect(first.frames).toEqual([]) // no newline yet → nothing complete
    const second = decodeFrames(first.rest, wire.slice(cut))
    expect(second.frames).toEqual([resp])
    expect(second.rest).toBe('')
  })

  it('decodes multiple frames in one chunk and carries a partial tail', () => {
    const a: ControlEvent = { event: true, channel: 'pty:data', args: ['s1', 'x'] }
    const b: ControlRequest = { id: 2, method: 'ravel.list', args: [] }
    const chunk = encodeFrame(a) + encodeFrame(b) + '{"id":3,"metho' // trailing partial
    const { frames, rest } = decodeFrames('', chunk)
    expect(frames).toEqual([a, b])
    expect(rest).toBe('{"id":3,"metho')
  })

  it('discriminates event / request / response frames', () => {
    const event: ControlFrame = { event: true, channel: 'ravel:update', args: [{}] }
    const request: ControlFrame = { id: 1, method: 'x', args: [] }
    const response: ControlFrame = { id: 1, ok: false, error: 'nope' }
    expect(isEvent(event)).toBe(true)
    expect(isRequest(event)).toBe(false)
    expect(isRequest(request)).toBe(true)
    expect(isResponse(request)).toBe(false)
    expect(isResponse(response)).toBe(true)
    expect(isEvent(response)).toBe(false)
  })
})
