// Wire protocol for the Core's LOCAL control channel — the loopback link the
// Electron client uses to drive the backend that now lives in the Core process.
//
// This is a separate channel from Release B's remote HTTP api-contract on
// purpose: it carries the full INTERNAL surface (pty byte streams, native
// dialogs, window intent) that must never be reachable from a paired phone.
//
// Framing is line-delimited JSON: every frame is one JSON object followed by a
// newline. Requests carry a client-assigned `id`; the matching response echoes
// it. Events are one-way pushes (the current `send(channel, …args)` payloads).
// This module is PURE — no sockets, no I/O — so the framing is unit-testable in
// isolation from the transport.

/** The first client→Core frame. No other frame is accepted before this. */
export interface ControlAuthRequest {
  auth: string
}

/** The Core→client acknowledgement for a valid control-channel secret. */
export interface ControlAuthResponse {
  auth: true
  ok: true
}

/** A client→Core call. `id` correlates the response; `args` mirror the backend fn. */
export interface ControlRequest {
  id: number
  method: string
  args: unknown[]
}

/** The Core→client reply to a {@link ControlRequest}, keyed by the same `id`. */
export interface ControlResponse {
  id: number
  ok: boolean
  value?: unknown
  /** Safe message when `ok` is false; never a raw stack. */
  error?: string
}

/** A one-way Core→client push mirroring an `ipcMain`-style `send(channel, …args)`. */
export interface ControlEvent {
  event: true
  channel: string
  args: unknown[]
}

export type ControlFrame = ControlAuthRequest | ControlAuthResponse | ControlRequest | ControlResponse | ControlEvent

/** The Core-side dispatch table: method name → the backend function it proxies. */
export type ControlHandlers = Record<string, (...args: unknown[]) => unknown | Promise<unknown>>

/** True when a frame is a one-way event push rather than a request/response. */
export function isEvent(frame: ControlFrame): frame is ControlEvent {
  return typeof frame === 'object' && frame !== null && 'event' in frame && frame.event === true
}

/** True when a frame is a client→Core request. */
export function isRequest(frame: ControlFrame): frame is ControlRequest {
  return (
    typeof frame === 'object' &&
    frame !== null &&
    !isEvent(frame) &&
    'method' in frame &&
    typeof frame.method === 'string'
  )
}

/** True when a frame is a client→Core authentication handshake. */
export function isAuthRequest(frame: ControlFrame): frame is ControlAuthRequest {
  return typeof frame === 'object' && frame !== null && 'auth' in frame && typeof frame.auth === 'string'
}

/** True when a frame is the Core's authentication acknowledgement. */
export function isAuthResponse(frame: ControlFrame): frame is ControlAuthResponse {
  return (
    typeof frame === 'object' &&
    frame !== null &&
    'auth' in frame &&
    frame.auth === true &&
    'ok' in frame &&
    frame.ok === true
  )
}

/** True when a frame is the Core→client response. */
export function isResponse(frame: ControlFrame): frame is ControlResponse {
  return (
    typeof frame === 'object' &&
    frame !== null &&
    'id' in frame &&
    typeof frame.id === 'number' &&
    'ok' in frame &&
    typeof frame.ok === 'boolean'
  )
}

/** Serialize one frame to a single newline-terminated line. */
export function encodeFrame(frame: ControlFrame): string {
  return JSON.stringify(frame) + '\n'
}

/**
 * Decode as many complete frames as `chunk` (appended to any buffered `rest`)
 * contains, returning the parsed frames and the leftover partial line to carry
 * into the next call. A frame split across TCP reads is therefore reassembled
 * rather than dropped or mis-parsed.
 */
export function decodeFrames(rest: string, chunk: string): { frames: ControlFrame[]; rest: string } {
  const data = rest + chunk
  const parts = data.split('\n')
  const carry = parts.pop() ?? '' // trailing element is the incomplete line (or '')
  const frames: ControlFrame[] = []
  for (const part of parts) {
    if (part.length === 0) continue
    frames.push(JSON.parse(part) as ControlFrame)
  }
  return { frames, rest: carry }
}
