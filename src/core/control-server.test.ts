import { connect, type Socket } from 'node:net'
import { afterEach, describe, it, expect } from 'vitest'
import { createControlServer, type ControlServer } from './control-server'
import {
  decodeFrames,
  encodeFrame,
  isResponse,
  isEvent,
  type ControlFrame,
  type ControlAuthRequest,
  type ControlResponse
} from './control-protocol'

/** A tiny promise client: connect, authenticate, then send-request / await-response and await-event. */
function client(port: number, secret: string): {
  socket: Socket
  ready: Promise<void>
  request(id: number, method: string, args: unknown[]): Promise<ControlResponse>
  nextEvent(): Promise<{ channel: string; args: unknown[] }>
} {
  const socket = connect(port, '127.0.0.1')
  socket.setEncoding('utf8')
  const responders = new Map<number, (r: ControlResponse) => void>()
  const eventWaiters: ((e: { channel: string; args: unknown[] }) => void)[] = []
  let rest = ''
  const readyResolvers = Promise.withResolvers<void>()
  socket.on('data', (chunk: string) => {
    const decoded = decodeFrames(rest, chunk as unknown as string)
    rest = decoded.rest
    for (const frame of decoded.frames as ControlFrame[]) {
      if (isResponse(frame)) responders.get(frame.id)?.(frame)
      else if (isEvent(frame)) eventWaiters.shift()?.({ channel: frame.channel, args: frame.args })
      else if ((frame as { auth?: boolean }).auth === true) readyResolvers.resolve()
    }
  })
  socket.once('connect', () => socket.write(encodeFrame({ auth: secret } satisfies ControlAuthRequest)))
  const ready = readyResolvers.promise
  return {
    socket,
    ready,
    request(id, method, args) {
      const { promise, resolve } = Promise.withResolvers<ControlResponse>()
      responders.set(id, resolve)
      socket.write(encodeFrame({ id, method, args }))
      return promise
    },
    nextEvent() {
      const { promise, resolve } = Promise.withResolvers<{ channel: string; args: unknown[] }>()
      eventWaiters.push(resolve)
      return promise
    }
  }
}

const SECRET = 'control-test-secret'

function waitForClose(socket: Socket): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  socket.once('close', () => resolve())
  return promise
}

describe('control server', () => {
  let server: ControlServer | null = null
  const clients: Socket[] = []

  afterEach(async () => {
    for (const c of clients) c.destroy()
    clients.length = 0
    if (server) await server.close()
    server = null
  })

  it('dispatches a request to its handler and returns the value', async () => {
    server = await createControlServer({
      handlers: { echo: async (x: unknown) => ({ echoed: x }) },
      secret: SECRET,
      port: 0
    })
    const c = client(server.port, SECRET)
    clients.push(c.socket)
    await c.ready
    const res = await c.request(1, 'echo', ['hi'])
    expect(res).toEqual({ id: 1, ok: true, value: { echoed: 'hi' } })
  })
  it('rejects an unknown method and surfaces a handler throw safely', async () => {
    server = await createControlServer({
      handlers: {
        boom: async () => {
          throw new Error('kaboom')
        }
      },
      secret: SECRET,
      port: 0
    })
    const c = client(server.port, SECRET)
    clients.push(c.socket)
    await c.ready

    const unknown = await c.request(1, 'nope', [])
    expect(unknown.ok).toBe(false)
    expect(unknown.error).toMatch(/unknown control method/)

    const thrown = await c.request(2, 'boom', [])
    expect(thrown).toEqual({ id: 2, ok: false, error: 'kaboom' })
  })

  it('fans an emitted event out to a connected client', async () => {
    server = await createControlServer({ handlers: { ping: async () => 'pong' }, secret: SECRET, port: 0 })
    const c = client(server.port, SECRET)
    clients.push(c.socket)
    await c.ready
    // Round-trip first so the server has registered this socket before we emit.
    await c.request(0, 'ping', [])
    const eventPromise = c.nextEvent()
    server.emit('ravel:update', { id: 'r1' })
    expect(await eventPromise).toEqual({ channel: 'ravel:update', args: [{ id: 'r1' }] })
  })

  it('destroys a connection that sends a request before authenticating', async () => {
    let called = false
    server = await createControlServer({
      handlers: { echo: async () => { called = true; return 'unexpected' } },
      secret: SECRET,
      port: 0
    })
    const socket = connect(server.port, '127.0.0.1')
    clients.push(socket)
    await new Promise<void>((resolve) => socket.once('connect', resolve))
    const closed = waitForClose(socket)
    socket.write(encodeFrame({ id: 1, method: 'echo', args: [] }))
    await closed
    expect(called).toBe(false)
  })

  it('destroys a connection that presents the wrong secret', async () => {
    server = await createControlServer({ handlers: {}, secret: SECRET, port: 0 })
    const socket = connect(server.port, '127.0.0.1')
    clients.push(socket)
    await new Promise<void>((resolve) => socket.once('connect', resolve))
    const closed = waitForClose(socket)
    socket.write(encodeFrame({ auth: 'wrong-secret' } satisfies ControlAuthRequest))
    await closed
  })
})
