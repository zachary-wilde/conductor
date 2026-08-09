// The Core side of the local control channel: a loopback TCP server that
// dispatches each {@link ControlRequest} to a backend handler and fans
// {@link ControlEvent} pushes out to every connected client.
//
// It owns no backend state — the `handlers` map and the event source are
// injected — so the transport is testable against a fake handler table, and the
// concrete map (session/ravel/roundtable/… proxies) is wired where the Core
// boots. Bind host defaults to loopback; this channel is never LAN-exposed.

import { timingSafeEqual } from 'node:crypto'
import { createServer, type Server, type Socket } from 'node:net'
import {
  decodeFrames,
  encodeFrame,
  isAuthRequest,
  isRequest,
  type ControlAuthResponse,
  type ControlEvent,
  type ControlHandlers,
  type ControlRequest,
  type ControlResponse
} from './control-protocol'

export interface ControlServer {
  /** The loopback port the channel bound. */
  port: number
  /** Push a one-way event to every connected client. */
  emit(channel: string, ...args: unknown[]): void
  /** Close all client sockets and stop listening. */
  close(): Promise<void>
}

export interface ControlServerOptions {
  handlers: ControlHandlers
  /** Per-boot secret required in the first frame on every connection. */
  secret: string
  /** Loopback port; 0 = ephemeral (tests). */
  port?: number
  /** Loopback host; defaults to 127.0.0.1 — never a LAN interface. */
  host?: string
}

/** Bind the control server on loopback and start dispatching. */
export async function createControlServer(options: ControlServerOptions): Promise<ControlServer> {
  if (options.secret.length === 0) throw new Error('control channel secret must not be empty')
  const expected = Buffer.from(options.secret)
  const sockets = new Set<Socket>()
  const authenticatedSockets = new Set<Socket>()

  const server = createServer((socket) => {
    sockets.add(socket)
    socket.setEncoding('utf8')
    let rest = ''
    let authenticated = false
    socket.on('data', (chunk: string) => {
      let decoded
      try {
        decoded = decodeFrames(rest, chunk)
      } catch {
        socket.destroy()
        return
      }
      rest = decoded.rest
      for (const frame of decoded.frames) {
        if (!authenticated) {
          if (!isAuthRequest(frame)) {
            socket.destroy()
            return
          }
          const received = Buffer.from(frame.auth)
          if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
            socket.destroy()
            return
          }
          authenticated = true
          authenticatedSockets.add(socket)
          socket.write(encodeFrame({ auth: true, ok: true } satisfies ControlAuthResponse))
          continue
        }
        if (isRequest(frame)) void dispatch(socket, frame, options.handlers)
      }
    })
    socket.on('close', () => {
      sockets.delete(socket)
      authenticatedSockets.delete(socket)
    })
    socket.on('error', () => {
      sockets.delete(socket)
      authenticatedSockets.delete(socket)
      socket.destroy()
    })
  })

  const port = await listen(server, options.port ?? 0, options.host ?? '127.0.0.1')

  return {
    port,
    emit(channel, ...args) {
      const line = encodeFrame({ event: true, channel, args } satisfies ControlEvent)
      for (const socket of authenticatedSockets) socket.write(line)
    },
    async close() {
      authenticatedSockets.clear()
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      const { promise, resolve } = Promise.withResolvers<void>()
      server.close(() => resolve())
      await promise
    }
  }
}

/** Run one request through its handler and write back a response frame. */
async function dispatch(socket: Socket, request: ControlRequest, handlers: ControlHandlers): Promise<void> {
  const handler = handlers[request.method]
  let response: ControlResponse
  if (!handler) {
    response = { id: request.id, ok: false, error: `unknown control method "${request.method}"` }
  } else {
    try {
      response = { id: request.id, ok: true, value: await handler(...request.args) }
    } catch (error) {
      response = { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
  socket.write(encodeFrame(response))
}

/** Resolve once the server is listening, to the actual bound port. */
function listen(server: Server, port: number, host: string): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>()
  server.once('error', reject)
  server.listen(port, host, () => {
    const address = server.address()
    if (address && typeof address === 'object') resolve(address.port)
    else reject(new Error('control server bound to a non-inet address'))
  })
  return promise
}
