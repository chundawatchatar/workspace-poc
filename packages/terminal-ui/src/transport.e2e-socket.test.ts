import { afterEach, describe, expect, test } from 'bun:test'
import {
  CLOSE_E2E_SESSION_UNKNOWN,
  DEVICE_PROOF_SOCKET_METHOD,
  machineSealedSocketPath,
  RELAY_TICKET_TTL_SECONDS,
} from '@orch/shared'
import { e2eMachine, HANDSHAKE, payloadOf, type SocketTamper, servers } from '../test/e2eMachine'

// The remote transport with a pinned machine key: every socket sealed on its own channel of the session, against the
// fake machine in `test/e2eMachine.ts`, which plays the relay and the host.

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
})

/** What the page sees on `socket`: each message's data, and the close code once it closes. */
function watch(socket: WebSocket) {
  const received: unknown[] = []
  const opened = new Promise<void>((resolve) => {
    socket.onopen = () => resolve()
  })
  const closed = new Promise<number>((resolve) => {
    socket.onclose = (event) => resolve(event.code)
  })
  socket.onmessage = (event) => received.push(event.data)
  return { received, opened, closed }
}

async function until(check: () => boolean, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await Bun.sleep(2)
  }
}

const TICKET = 'eyJhbGciOiJFZERTQSJ9.relay-ticket.sig'

describe('sealed sockets through the remote transport', () => {
  test('a socket goes sealed on the next channel, with nothing in clear, and messages round-trip typed and in order', async () => {
    const { machineId, sealed, sockets, transport: make } = await e2eMachine()
    const expiresAt = new Date(Date.now() + RELAY_TICKET_TTL_SECONDS * 1000).toISOString()
    const transport = await make({ relayTicket: async () => ({ ticket: TICKET, expiresAt }) })
    await transport.request('/api/health', {})
    const socket = transport.openSocket('/ws/term/t1?cwd=%2Fsecret')
    socket.binaryType = 'arraybuffer'
    const page = watch(socket)
    await page.opened
    socket.send('{"type":"input","data":"ls"}')
    socket.send(Uint8Array.of(1, 2, 3))
    socket.send('é')
    await transport.request('/api/health', {})
    await until(() => page.received.length === 3)

    expect(page.received[0]).toBe('{"type":"input","data":"ls"}')
    expect([...new Uint8Array(page.received[1] as ArrayBuffer)]).toEqual([1, 2, 3])
    expect(page.received[2]).toBe('é')
    const [seen] = sockets
    expect(new URL(seen?.url ?? '').pathname).toBe(machineSealedSocketPath(machineId))
    expect(seen?.protocols).toBeNull()
    expect(seen?.open).toMatchObject({
      path: '/ws/term/t1?cwd=%2Fsecret',
      auth: { type: 'auth', account: true },
      ticket: TICKET,
    })
    expect(payloadOf(seen?.open.auth.device ?? '')).toMatchObject({
      method: DEVICE_PROOF_SOCKET_METHOD,
      path: '/ws/term/t1?cwd=%2Fsecret',
    })
    expect(seen?.messages).toEqual(['{"type":"input","data":"ls"}', Uint8Array.of(1, 2, 3), 'é'])
    // The envelope came first, before anything the page sent from its `onopen`, and every frame is binary.
    expect(seen?.frames).toHaveLength(4)
    expect(seen?.frames.every((frame) => frame instanceof Uint8Array)).toBe(true)
    const clear = Buffer.concat(seen?.frames as Uint8Array[]).toString('latin1')
    const secrets = ['/ws/', 'secret', TICKET, 'ls', seen?.open.auth.device ?? '']
    expect(secrets.filter((text) => clear.includes(text))).toEqual([])
    // Requests and sockets share one counter, so channels never repeat.
    expect([sealed[0]?.channel, seen?.channel, sealed[1]?.channel]).toEqual([1, 2, 3])

    // Without `binaryType = 'arraybuffer'`, binary arrives as a `Blob`, as on a real socket.
    const blobs = transport.openSocket('/ws/events')
    const other = watch(blobs)
    await other.opened
    blobs.send(Uint8Array.of(9))
    await until(() => other.received.length === 1)
    expect(other.received[0]).toBeInstanceOf(Blob)
    expect([...new Uint8Array(await (other.received[0] as Blob).arrayBuffer())]).toEqual([9])
    expect(sockets[1]?.channel).toBe(4)
  })

  test('the outer close code reaches the page as it is, and an unknown session is dropped for the next call', async () => {
    const { seen, state, sessions, transport: make } = await e2eMachine()
    const transport = await make()
    for (const code of [4401, 4403, 4502, 4429, 4410]) {
      state.socketClose = code
      expect([code, await watch(transport.openSocket('/ws/events')).closed]).toEqual([code, code])
    }
    expect(seen.filter((line) => line === HANDSHAKE)).toHaveLength(1)

    state.socketClose = null
    sessions.clear()
    expect(await watch(transport.openSocket('/ws/events')).closed).toBe(CLOSE_E2E_SESSION_UNKNOWN)
    expect(seen.filter((line) => line === HANDSHAKE)).toHaveLength(1)
    const next = watch(transport.openSocket('/ws/events'))
    await next.opened
    expect(seen.filter((line) => line === HANDSHAKE)).toHaveLength(2)
  })

  test('a tampered, replayed, reordered, mistyped or text message from the relay ends the socket with 1006', async () => {
    const tampers: SocketTamper[] = ['bad record', 'replay', 'reorder', 'wrong kind', 'text']
    for (const tamper of tampers) {
      const { sockets, state, transport: make } = await e2eMachine()
      state.socketTamper = tamper
      const transport = await make()
      const socket = transport.openSocket('/ws/events')
      const page = watch(socket)
      await page.opened
      socket.send('one')
      expect([tamper, await page.closed]).toEqual([tamper, 1006])
      await until(() => sockets[0]?.closed === true)
      // Only a message that opened in order before the tampering ever reaches the page.
      expect([tamper, page.received]).toEqual([tamper, tamper === 'replay' ? ['one'] : []])
      expect(socket.readyState).toBe(WebSocket.CLOSED)
    }
  })
})
