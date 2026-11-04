import { afterEach, describe, expect, test } from 'bun:test'
import {
  ACCESS_KEY_HEADER,
  buildRequest,
  buildSocketUrl,
  CLOSE_ACCESS_DENIED,
  DEVICE_PROOF_HEADER,
  RELAY_TICKET_HEADER,
  relaySocketProtocols,
  routes,
} from '@orch/shared'
import { callApi } from './lib/api'
import { type DeviceSigner, deviceSigner } from './lib/deviceProof'
import { connect, getSnapshot } from './lib/store'
import { createLocalTransport, createRemoteTransport, type HostTransport } from './transport'

/** Records what the page asks for, instead of reaching a host. */
function fakeTransport() {
  const requests: { path: string; init: RequestInit }[] = []
  const sockets: { path: string; closed: boolean; socket: WebSocket }[] = []
  const transport: HostTransport = {
    request: async (path, init) => {
      requests.push({ path, init })
      return Response.json({ branch: 'main', changes: 2 })
    },
    openSocket: (path) => {
      const entry = { path, closed: false, socket: {} as WebSocket }
      entry.socket = { close: () => (entry.closed = true) } as unknown as WebSocket
      sockets.push(entry)
      return entry.socket
    },
  }
  return { transport, requests, sockets }
}

let disconnect = () => {}
const servers: Bun.Server<unknown>[] = []
const RealWebSocket = globalThis.WebSocket
afterEach(() => {
  disconnect()
  for (const server of servers.splice(0)) server.stop(true)
  globalThis.WebSocket = RealWebSocket
})

/** A server that records each request's URL and headers and each socket message, resolving once `count` arrive. */
function recordingServer(count: number) {
  const seen: { url: string; headers: Record<string, string> }[] = []
  const messages: string[] = []
  const { promise: received, resolve } = Promise.withResolvers<void>()
  const server = Bun.serve({
    port: 0,
    hostname: 'localhost',
    fetch(req, srv) {
      seen.push({ url: req.url, headers: Object.fromEntries(req.headers) })
      if (srv.upgrade(req)) return
      return new Response('ok')
    },
    websocket: {
      message(_ws, message) {
        messages.push(String(message))
        if (messages.length === count) resolve()
      },
    },
  })
  servers.push(server)
  return { base: `http://localhost:${server.port}`, seen, messages, received }
}

/** A fresh WebCrypto device key, as a browser keeps one. */
async function testSigner(): Promise<DeviceSigner> {
  return deviceSigner(
    await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']),
  )
}

/** The payload of a device proof. */
const payloadOf = (proof: string) => JSON.parse(Buffer.from(proof.split('.')[1] ?? '', 'base64url').toString())

/** True when `proof` carries `signer`'s public key and its signature verifies under it. */
async function signedBy(proof: string, signer: DeviceSigner) {
  const [header = '', payload = '', signature = ''] = proof.split('.')
  const { jwk } = JSON.parse(Buffer.from(header, 'base64url').toString())
  if (jwk.x !== signer.publicJwk.x || jwk.y !== signer.publicJwk.y) return false
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    Buffer.from(signature, 'base64url'),
    new TextEncoder().encode(`${header}.${payload}`),
  )
}

describe('the page transport', () => {
  test('carries the events socket and every API call, and its cleanup stops reconnecting', async () => {
    const fake = fakeTransport()
    disconnect = connect(fake.transport)
    expect(fake.sockets.map((s) => s.path)).toEqual([buildSocketUrl(routes.sockets.events, {})])

    const git = await callApi(routes.git.status, { cwd: '/tmp/project' })
    expect(git).toEqual({ branch: 'main', changes: 2 })
    expect(fake.requests.map((r) => r.path)).toEqual([buildRequest(routes.git.status, { cwd: '/tmp/project' }).url])
    expect(fake.requests[0].init.method).toBe('GET')

    disconnect()
    expect(fake.sockets[0].closed).toBe(true)
    // A close that arrives after the cleanup must not mark the page offline or schedule a reconnect.
    fake.sockets[0].socket.onclose?.({} as CloseEvent)
    expect(getSnapshot().status).toBe('connecting')
    await expect(callApi(routes.git.status, { cwd: '/tmp' })).rejects.toThrow()
  })

  test('the local transport maps paths onto its base URL, with a ws:// scheme for sockets', async () => {
    const server = Bun.serve({
      port: 0,
      hostname: 'localhost',
      fetch: (req) => new Response(new URL(req.url).pathname),
    })
    servers.push(server)
    const base = `http://localhost:${server.port}`
    const transport = createLocalTransport(base)
    const { url } = buildRequest(routes.git.status, { cwd: '/tmp' })
    const response = await transport.request(url, { method: 'GET' })
    expect(await response.text()).toBe(routes.git.status.path)

    const path = buildSocketUrl(routes.sockets.events, {})
    const socket = transport.openSocket(path)
    expect(socket.url).toBe(`ws://localhost:${server.port}${path}`)
    socket.close()
  })

  test('the remote transport goes through the machine prefix and carries the key in a header or the first message', async () => {
    const machineId = 'mac/1 a'
    const accessKey = 'secret-key'
    const { base, seen, messages, received: twoMessages } = recordingServer(2)
    const port = new URL(base).port
    const transport = createRemoteTransport({ serverUrl: `${base}/`, machineId, accessKey })

    await transport.request('/api/git/status?cwd=%2Ftmp', { headers: { 'content-type': 'application/json' } })
    expect(seen[0].url).toBe(`${base}/m/mac%2F1%20a/api/git/status?cwd=%2Ftmp`)
    expect(seen[0].headers['content-type']).toBe('application/json')
    expect(seen[0].headers[ACCESS_KEY_HEADER]).toBe(accessKey)

    const socket = transport.openSocket('/ws/events')
    expect(socket.url).toBe(`ws://localhost:${port}/m/mac%2F1%20a/ws/events`)
    socket.onopen = () => socket.send('from the page')
    await twoMessages
    socket.close()
    expect(messages).toEqual([JSON.stringify({ type: 'auth', key: accessKey }), 'from the page'])
    expect(seen.every((s) => !s.url.includes(accessKey))).toBe(true)
  })

  test('without a key, requests share a relay ticket, each request and socket carries a fresh device proof', async () => {
    const { base, seen, messages, received } = recordingServer(2)
    let issued = 0
    const relayTicket = async () => ({
      ticket: `t${++issued}`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    const device = await testSigner()
    const transport = createRemoteTransport({ serverUrl: base, machineId: 'm1', relayTicket, device })

    await Promise.all([
      transport.request('/api/git/status?cwd=%2Ftmp', { headers: { 'content-type': 'application/json' } }),
      transport.request('/api/system/health', { method: 'post', body: '{"a":1}' }),
    ])
    expect(seen.map((s) => [s.headers[RELAY_TICKET_HEADER], ACCESS_KEY_HEADER in s.headers])).toEqual([
      ['t1', false],
      ['t1', false],
    ])
    expect(seen[0].headers.cookie).toBeUndefined()
    const proofs = seen.map((s) => s.headers[DEVICE_PROOF_HEADER] ?? '')
    expect(await Promise.all(proofs.map((proof) => signedBy(proof, device)))).toEqual([true, true])
    const [get, post] = proofs.map(payloadOf)
    expect(get).toMatchObject({ aud: 'm1', method: 'GET', path: '/api/git/status?cwd=%2Ftmp' })
    expect(post).toMatchObject({ aud: 'm1', method: 'POST', path: '/api/system/health' })
    expect(get.nonce).not.toBe(post.nonce)
    expect(get.bodySha256).not.toBe(post.bodySha256)
    await expect(transport.request('/api/x', { method: 'POST', body: new Uint8Array([1]) })).rejects.toThrow()

    const socket = transport.openSocket('/ws/events')
    expect(socket.url).toBe(`${base.replace('http', 'ws')}/m/m1/ws/events`)
    socket.onopen = () => socket.send('from the page')
    await received
    socket.close()
    expect(seen[2].headers['sec-websocket-protocol']).toBe(relaySocketProtocols('t2').join(', '))
    expect(seen[2].url).not.toContain('t2')
    const [auth, fromPage] = messages
    const { device: proof, ...rest } = JSON.parse(auth ?? '')
    expect(rest).toEqual({ type: 'auth', account: true })
    expect(await signedBy(proof, device)).toBe(true)
    expect(payloadOf(proof)).toMatchObject({ aud: 'm1', method: 'WS', path: '/ws/events' })
    expect(fromPage).toBe('from the page')
  })

  test('without a key, an account that cannot open the machine gets 401 and a denied socket, and no device key throws', async () => {
    const { base, seen } = recordingServer(1)
    const device = await testSigner()
    const relayTicket = async () => null
    const transport = createRemoteTransport({ serverUrl: base, machineId: 'm1', relayTicket, device })
    expect((await transport.request('/api/system/health', {})).status).toBe(401)
    const socket = transport.openSocket('/ws/events')
    const closed = await new Promise<CloseEvent>((resolve) => {
      socket.onclose = resolve
    })
    expect(closed.code).toBe(CLOSE_ACCESS_DENIED)
    expect(seen).toEqual([])
    expect(() => createRemoteTransport({ serverUrl: base, machineId: 'm1', relayTicket })).toThrow()
  })

  test('the remote transport uses wss:// for an https server and rejects other schemes', () => {
    const opened: string[] = []
    // Records the URL without reaching a TLS server. `afterEach` puts the real WebSocket back.
    globalThis.WebSocket = class {
      constructor(url: string) {
        opened.push(url)
      }
      addEventListener() {}
    } as unknown as typeof WebSocket
    createRemoteTransport({ serverUrl: 'https://example.com', machineId: 'm1', accessKey: 'k' }).openSocket(
      '/ws/events',
    )
    expect(opened).toEqual(['wss://example.com/m/m1/ws/events'])
    for (const serverUrl of ['ws://example.com', 'file:///tmp', 'javascript:alert(1)']) {
      expect(() => createRemoteTransport({ serverUrl, machineId: 'm1', accessKey: 'k' })).toThrow()
    }
  })
})
