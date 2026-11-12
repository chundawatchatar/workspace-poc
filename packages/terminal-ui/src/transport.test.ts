import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import {
  ACCESS_KEY_HEADER,
  answerBrowserHandshake,
  buildRequest,
  buildSocketUrl,
  CLOSE_ACCESS_DENIED,
  CLOSE_DEVICE_NOT_APPROVED,
  DEVICE_NOT_APPROVED_CODE,
  DEVICE_PROOF_HEADER,
  E2eError,
  type E2eMachineSigner,
  machineIdFromPublicKey,
  RELAY_TICKET_HEADER,
  relaySocketProtocols,
  routes,
  startBrowserHandshake,
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
  setSystemTime()
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

  test('with a key, every request and socket carries the key and a fresh device proof, and no device key throws', async () => {
    const machineId = 'mac/1 a'
    const accessKey = 'secret-key'
    const { base, seen, messages, received: twoMessages } = recordingServer(2)
    const port = new URL(base).port
    const device = await testSigner()
    const transport = createRemoteTransport({ serverUrl: `${base}/`, machineId, accessKey, device })

    await transport.request('/api/git/status?cwd=%2Ftmp', { headers: { 'content-type': 'application/json' } })
    await transport.request('/api/system/health', { method: 'post', body: '{"a":1}' })
    expect(seen[0].url).toBe(`${base}/m/mac%2F1%20a/api/git/status?cwd=%2Ftmp`)
    expect(seen[0].headers['content-type']).toBe('application/json')
    expect(seen.map((s) => s.headers[ACCESS_KEY_HEADER])).toEqual([accessKey, accessKey])
    const proofs = seen.map((s) => s.headers[DEVICE_PROOF_HEADER] ?? '')
    expect(await Promise.all(proofs.map((proof) => signedBy(proof, device)))).toEqual([true, true])
    const [get, post] = proofs.map(payloadOf)
    expect(get).toMatchObject({ aud: machineId, method: 'GET', path: '/api/git/status?cwd=%2Ftmp' })
    expect(post).toMatchObject({ aud: machineId, method: 'POST', path: '/api/system/health' })
    expect(get.nonce).not.toBe(post.nonce)
    expect(get.bodySha256).not.toBe(post.bodySha256)
    await expect(transport.request('/api/x', { method: 'POST', body: new Uint8Array([1]) })).rejects.toThrow()

    const socket = transport.openSocket('/ws/events')
    expect(socket.url).toBe(`ws://localhost:${port}/m/mac%2F1%20a/ws/events`)
    socket.onopen = () => socket.send('from the page')
    await twoMessages
    socket.close()
    const [auth, fromPage] = messages
    const { device: proof, ...rest } = JSON.parse(auth ?? '')
    expect(rest).toEqual({ type: 'auth', key: accessKey })
    expect(await signedBy(proof, device)).toBe(true)
    expect(payloadOf(proof)).toMatchObject({ aud: machineId, method: 'WS', path: '/ws/events' })
    expect(fromPage).toBe('from the page')
    expect(seen.every((s) => !s.url.includes(accessKey))).toBe(true)
    expect(() => createRemoteTransport({ serverUrl: base, machineId, accessKey })).toThrow()
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

  test('the remote transport uses wss:// for an https server and rejects other schemes', async () => {
    const device = await testSigner()
    const { promise: opened, resolve } = Promise.withResolvers<string>()
    // Records the URL without reaching a TLS server. `afterEach` puts the real WebSocket back.
    globalThis.WebSocket = class {
      constructor(url: string) {
        resolve(url)
      }
      addEventListener() {}
    } as unknown as typeof WebSocket
    createRemoteTransport({ serverUrl: 'https://example.com', machineId: 'm1', accessKey: 'k', device }).openSocket(
      '/ws/events',
    )
    expect(await opened).toBe('wss://example.com/m/m1/ws/events')
    for (const serverUrl of ['ws://example.com', 'file:///tmp', 'javascript:alert(1)']) {
      expect(() => createRemoteTransport({ serverUrl, machineId: 'm1', accessKey: 'k', device })).toThrow()
    }
  })
})

/** A fresh Ed25519 machine key, signing as the host's `MachineKey` does, and the machine id it hashes to. */
async function testMachine(): Promise<E2eMachineSigner & { machineId: string }> {
  const pair = (await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify'])) as CryptoKeyPair
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  const publicKey = Buffer.from(raw).toString('base64url')
  const sign = async (data: Uint8Array<ArrayBuffer>) =>
    new Uint8Array(await crypto.subtle.sign('Ed25519', pair.privateKey, data))
  return { publicKey, sign, machineId: await machineIdFromPublicKey(publicKey) }
}

/** How the fake machine answers a handshake: with a session, a refusal, or a reply that must not verify. */
type HandshakeAnswer =
  | { kind: 'session'; ttlMs: number }
  | { kind: 'refuse'; status: number; body?: unknown }
  | { kind: 'other key' | 'other hello' | 'bad shape' }

/**
 * A machine behind the relay that answers `routes.e2e.open` as `answer` says, and records every request and socket in
 * the order they arrive, as `POST /api/e2e/sessions`, `GET /api/health` or `WS /ws/events`.
 */
async function e2eMachine() {
  const machine = await testMachine()
  const impostor = await testMachine()
  const seen: string[] = []
  const state = { answer: { kind: 'session', ttlMs: 60_000 } as HandshakeAnswer }
  const prefix = `/m/${machine.machineId}`
  const reply = async (hello: unknown) => {
    const { answer } = state
    if (answer.kind === 'refuse') return Response.json(answer.body ?? { error: 'no' }, { status: answer.status })
    if (answer.kind === 'bad shape') return Response.json({ sessionId: 'x' })
    const signer = answer.kind === 'other key' ? { ...machine, sign: impostor.sign } : machine
    const answered =
      answer.kind === 'other hello'
        ? (await startBrowserHandshake({ machineId: machine.machineId, device: await testSigner() })).hello
        : hello
    const { reply } = await answerBrowserHandshake({ machineId: machine.machineId, machine: signer, hello: answered })
    const ttlMs = answer.kind === 'session' ? answer.ttlMs : 60_000
    const expiresAt = new Date(Date.now() + ttlMs).toISOString()
    return Response.json({ sessionId: 'A'.repeat(22), hello: reply, expiresAt })
  }
  const server = Bun.serve({
    port: 0,
    hostname: 'localhost',
    async fetch(req, srv) {
      const path = new URL(req.url).pathname.slice(prefix.length)
      if (srv.upgrade(req)) {
        seen.push(`WS ${path}`)
        return
      }
      seen.push(`${req.method} ${path}`)
      if (path === routes.e2e.open.path) return reply(await req.json())
      return new Response('ok')
    },
    websocket: { message() {} },
  })
  servers.push(server)
  const transport = async (options: { onMachineUnverified?: () => void } = {}) =>
    createRemoteTransport({
      serverUrl: `http://localhost:${server.port}`,
      machineId: machine.machineId,
      accessKey: 'k',
      device: await testSigner(),
      machinePublicKey: machine.publicKey,
      ...options,
    })
  return { seen, state, transport }
}

/** The close code `socket` ends with, or `'open'` once it opens. */
const outcome = (socket: WebSocket) =>
  new Promise<number | 'open'>((resolve) => {
    socket.onopen = () => {
      resolve('open')
      socket.close()
    }
    socket.onclose = (event) => resolve(event.code)
  })

const HANDSHAKE = `POST ${routes.e2e.open.path}`

describe('the remote transport with a pinned machine key', () => {
  test('one shared handshake comes before the first request and socket, and a new one before the session expires', async () => {
    const { seen, state, transport: make } = await e2eMachine()
    state.answer = { kind: 'session', ttlMs: 20_000 }
    const transport = await make()
    const [first, second, socket] = await Promise.all([
      transport.request('/api/health', {}),
      transport.request('/api/daemon', {}),
      outcome(transport.openSocket('/ws/events')),
    ])
    expect([first.status, second.status, socket]).toEqual([200, 200, 'open'])
    expect(seen[0]).toBe(HANDSHAKE)
    expect(seen.slice(1).sort()).toEqual(['GET /api/daemon', 'GET /api/health', 'WS /ws/events'])

    await transport.request('/api/health', {})
    expect(seen.filter((line) => line === HANDSHAKE)).toHaveLength(1)
    // Inside the margin before it expires, the next call opens a new session first.
    setSystemTime(new Date(Date.now() + 6_000))
    await transport.request('/api/health', {})
    expect(seen.slice(-2)).toEqual([HANDSHAKE, 'GET /api/health'])
  })

  test('a refused handshake answers requests with its status and fails sockets with the code the page knows, then retries', async () => {
    const { seen, state, transport: make } = await e2eMachine()
    const transport = await make()
    state.answer = { kind: 'refuse', status: 401 }
    const refused = await transport.request('/api/health', {})
    expect(refused.status).toBe(401)
    expect(await outcome(transport.openSocket('/ws/events'))).toBe(CLOSE_ACCESS_DENIED)
    state.answer = { kind: 'refuse', status: 403, body: { error: 'wait', code: DEVICE_NOT_APPROVED_CODE } }
    const [unapproved, socket] = await Promise.all([
      transport.request('/api/health', {}),
      outcome(transport.openSocket('/ws/events')),
    ])
    expect([unapproved.status, await unapproved.json(), socket]).toEqual([
      403,
      { error: 'wait', code: DEVICE_NOT_APPROVED_CODE },
      CLOSE_DEVICE_NOT_APPROVED,
    ])
    state.answer = { kind: 'refuse', status: 500 }
    expect(await outcome(transport.openSocket('/ws/events'))).toBe(1006)
    expect(seen).toEqual([HANDSHAKE, HANDSHAKE, HANDSHAKE, HANDSHAKE])

    state.answer = { kind: 'session', ttlMs: 60_000 }
    expect((await transport.request('/api/health', {})).status).toBe(200)
    expect(seen.slice(-2)).toEqual([HANDSHAKE, 'GET /api/health'])
  })

  test('an answer that does not verify stops the transport for good and reports it once', async () => {
    for (const kind of ['other key', 'other hello', 'bad shape'] as const) {
      const { seen, state, transport: make } = await e2eMachine()
      state.answer = { kind }
      let reported = 0
      const transport = await make({ onMachineUnverified: () => reported++ })
      const [request, socket] = await Promise.allSettled([
        transport.request('/api/health', {}),
        outcome(transport.openSocket('/ws/events')),
      ])
      expect(request.status === 'rejected' && request.reason).toBeInstanceOf(E2eError)
      expect(socket).toEqual({ status: 'fulfilled', value: 1006 })

      state.answer = { kind: 'session', ttlMs: 60_000 }
      await expect(transport.request('/api/health', {})).rejects.toBeInstanceOf(E2eError)
      expect(await outcome(transport.openSocket('/ws/events'))).toBe(1006)
      expect([kind, seen, reported]).toEqual([kind, [HANDSHAKE], 1])
    }
  })
})
