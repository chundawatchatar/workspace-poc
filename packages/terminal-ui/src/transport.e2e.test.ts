import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import {
  ACCESS_KEY_HEADER,
  answerBrowserHandshake,
  CLOSE_ACCESS_DENIED,
  CLOSE_DEVICE_NOT_APPROVED,
  DEVICE_NOT_APPROVED_CODE,
  DEVICE_PROOF_HEADER,
  decodeEnvelope,
  decodeRequestRecord,
  E2E_SESSION_UNKNOWN_CODE,
  E2eError,
  type E2eHttpRequest,
  type E2eHttpResponseRecord,
  type E2eMachineSigner,
  type E2eSession,
  encodeResponseRecord,
  frameRecord,
  machineIdFromPublicKey,
  RELAY_TICKET_HEADER,
  routes,
  startBrowserHandshake,
} from '@orch/shared'
import { type DeviceSigner, deviceSigner } from './lib/deviceProof'
import { createRemoteTransport } from './transport'

// The remote transport with a pinned machine key: the end-to-end handshake, then every request sealed on its own
// channel, against a fake machine behind the relay that plays the host's side.

const servers: Bun.Server<unknown>[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
  setSystemTime()
})

/** A fresh WebCrypto device key, as a browser keeps one. */
async function testSigner(): Promise<DeviceSigner> {
  return deviceSigner(
    await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']),
  )
}

/** The payload of a device proof. */
const payloadOf = (proof: string) => JSON.parse(Buffer.from(proof.split('.')[1] ?? '', 'base64url').toString())

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

/** How the relay mangles a sealed reply on its way back, if at all. */
type Tamper = 'bad head' | 'bad body' | 'reorder' | 'truncate' | 'end error' | null

/** What the fake machine saw of one sealed request: the outer request as the relay got it, and what was inside. */
interface SealedSeen {
  headers: Headers
  raw: Uint8Array
  sessionId: string
  channel: number
  inner: E2eHttpRequest
}

/**
 * A machine behind the relay that answers `routes.e2e.open` as `answer` says, opens sealed requests on their channel
 * and answers them sealed, and records every request and socket in the order they arrive, as
 * `POST /api/e2e/sessions`, `GET /api/health` or `WS /ws/events`. A sealed request's handler answers `ok`, or the
 * chunks in `state.chunks`, after `state.delayMs[path]`; `state.outer` answers the envelope unsealed instead.
 */
async function e2eMachine() {
  const machine = await testMachine()
  const impostor = await testMachine()
  const seen: string[] = []
  const sealed: SealedSeen[] = []
  const sessions = new Map<string, E2eSession>()
  const state = {
    answer: { kind: 'session', ttlMs: 60_000 } as HandshakeAnswer,
    outer: null as { status: number; body: unknown } | null,
    tamper: null as Tamper,
    chunks: ['ok'],
    delayMs: {} as Record<string, number>,
  }
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
    const handshake = await answerBrowserHandshake({ machineId: machine.machineId, machine: signer, hello: answered })
    const ttlMs = answer.kind === 'session' ? answer.ttlMs : 60_000
    const expiresAt = new Date(Date.now() + ttlMs).toISOString()
    const sessionId = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url')
    sessions.set(sessionId, handshake.session)
    return Response.json({ sessionId, hello: handshake.reply, expiresAt })
  }
  const answerSealed = async (req: Request) => {
    const raw = new Uint8Array(await req.arrayBuffer())
    if (state.outer) return Response.json(state.outer.body, { status: state.outer.status })
    const envelope = decodeEnvelope(raw)
    const session = sessions.get(envelope.sessionId)
    if (!session) return Response.json({ code: E2E_SESSION_UNKNOWN_CODE }, { status: 409 })
    const channel = await session.channel(envelope.channel)
    const inner = decodeRequestRecord(await channel.open(envelope.sealed))
    sealed.push({ headers: req.headers, raw, sessionId: envelope.sessionId, channel: envelope.channel, inner })
    seen.push(`${inner.method} ${inner.path}`)
    await Bun.sleep(state.delayMs[inner.path] ?? 0)
    const records: E2eHttpResponseRecord[] = [
      { kind: 'head', head: { status: 200, headers: [['x-inner', inner.path]] } },
      ...state.chunks.map((chunk) => ({ kind: 'body' as const, data: new TextEncoder().encode(chunk) })),
      state.tamper === 'end error' ? { kind: 'end', error: 'failed' } : { kind: 'end' },
    ]
    const out: Uint8Array[] = []
    for (const record of records) out.push(await channel.seal(encodeResponseRecord(record)))
    const flip = (index: number) => {
      const copy = new Uint8Array(out[index] ?? [])
      copy[copy.length - 1] = (copy[copy.length - 1] ?? 0) ^ 1
      out[index] = copy
    }
    if (state.tamper === 'bad head') flip(0)
    if (state.tamper === 'bad body') flip(1)
    if (state.tamper === 'reorder') out.splice(1, 2, out[2] as Uint8Array, out[1] as Uint8Array)
    if (state.tamper === 'truncate') out.pop()
    return new Response(Buffer.concat(out.map(frameRecord)), {
      headers: { 'content-type': 'application/octet-stream' },
    })
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
      if (path === '/e2e' && req.method === 'POST') return answerSealed(req)
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
  return { seen, sealed, state, transport }
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

  test('each request goes sealed as one POST, with no credential in its headers or in clear in its body', async () => {
    const { seen, sealed, state, transport: make } = await e2eMachine()
    const transport = await make()
    state.delayMs = { '/api/slow': 40 }
    const [slow, fast, posted] = await Promise.all([
      transport.request('/api/slow?cwd=%2Fsecret', {}),
      transport.request('/api/fast', {}),
      transport.request('/api/fs/make-dir', { method: 'post', body: '{"path":"/tmp/x"}' }),
    ])
    expect(await Promise.all([slow, fast, posted].map((r) => r.text()))).toEqual(['ok', 'ok', 'ok'])
    expect(slow.headers.get('x-inner')).toBe('/api/slow?cwd=%2Fsecret')
    expect(seen.slice(0, 1)).toEqual([HANDSHAKE])
    expect(sealed.map((s) => s.inner.method).sort()).toEqual(['GET', 'GET', 'POST'])
    expect(sealed.find((s) => s.inner.method === 'POST')?.inner.body).toBe('{"path":"/tmp/x"}')

    for (const { headers, raw, inner } of sealed) {
      expect([ACCESS_KEY_HEADER, RELAY_TICKET_HEADER, DEVICE_PROOF_HEADER].some((name) => headers.has(name))).toBe(
        false,
      )
      expect(new Headers(inner.headers).get(ACCESS_KEY_HEADER)).toBe('k')
      expect(payloadOf(new Headers(inner.headers).get(DEVICE_PROOF_HEADER) ?? '')).toMatchObject({
        method: inner.method,
        path: inner.path,
      })
      const clear = Buffer.from(raw).toString('latin1')
      expect(['/api/', 'secret', 'make-dir', 'tmp'].some((text) => clear.includes(text))).toBe(false)
    }
    await transport.request('/api/health', {})
    // One session, and its channels rise from 1 and are never reused.
    expect(new Set(sealed.map((s) => s.sessionId)).size).toBe(1)
    expect(sealed.map((s) => s.channel).sort()).toEqual([1, 2, 3, 4])
  })

  test('an outer refusal comes back as it is, and an unknown session is dropped for the next call without a retry', async () => {
    const { seen, state, transport: make } = await e2eMachine()
    const transport = await make()
    for (const status of [403, 413, 429, 502, 504]) {
      state.outer = { status, body: { error: `outer ${status}` } }
      const response = await transport.request('/api/health', {})
      expect([response.status, await response.json()]).toEqual([status, { error: `outer ${status}` }])
    }
    expect(seen).toEqual([HANDSHAKE])

    state.outer = { status: 409, body: { error: 'gone', code: E2E_SESSION_UNKNOWN_CODE } }
    const unknown = await transport.request('/api/health', {})
    expect([unknown.status, (await unknown.json()).code]).toEqual([409, E2E_SESSION_UNKNOWN_CODE])
    expect(seen).toEqual([HANDSHAKE])
    state.outer = null
    expect(await (await transport.request('/api/health', {})).text()).toBe('ok')
    expect(seen).toEqual([HANDSHAKE, HANDSHAKE, 'GET /api/health'])
  })

  test('a reply whose head does not open rejects, and a mangled body never ends cleanly', async () => {
    const { state, transport: make } = await e2eMachine()
    const transport = await make()
    state.chunks = ['one', 'two']
    state.tamper = 'bad head'
    await expect(transport.request('/api/health', {})).rejects.toBeInstanceOf(E2eError)
    for (const tamper of ['bad body', 'reorder', 'truncate', 'end error'] as const) {
      state.tamper = tamper
      const response = await transport.request('/api/health', {})
      expect([tamper, response.status]).toEqual([tamper, 200])
      const outcome = await response.text().then(
        (text) => `ended: ${text}`,
        (error: unknown) => error,
      )
      expect([tamper, outcome]).toEqual([tamper, expect.any(E2eError)])
    }
    state.tamper = null
    expect(await (await transport.request('/api/health', {})).text()).toBe('onetwo')
  })
})
