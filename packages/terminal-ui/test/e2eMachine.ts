import {
  answerBrowserHandshake,
  CLOSE_E2E_SESSION_UNKNOWN,
  decodeEnvelope,
  decodeRequestRecord,
  decodeSocketMessageRecord,
  decodeSocketOpenRecord,
  E2E_SESSION_UNKNOWN_CODE,
  type E2eChannel,
  type E2eHttpRequest,
  type E2eHttpResponseRecord,
  type E2eMachineSigner,
  type E2eSession,
  type E2eSocketMessage,
  type E2eSocketOpen,
  encodeResponseRecord,
  encodeSocketMessageRecord,
  encodeSocketOpenRecord,
  frameRecord,
  machineIdFromPublicKey,
  routes,
  startBrowserHandshake,
} from '@orch/shared'
import type { ServerWebSocket } from 'bun'
import { type DeviceSigner, deviceSigner } from '../src/lib/deviceProof'
import { createRemoteTransport, type RemoteTransportOptions } from '../src/transport'

// Test-only: a machine behind the relay for the remote transport's tests with a pinned machine key. It plays the
// server and the host at once: it answers the end-to-end handshake, opens sealed requests and sockets, and answers
// them sealed. Never imported by production code.

/** The servers the fake machines started. Each test file stops them after each test. */
export const servers: Bun.Server<unknown>[] = []

/** The relay ticket `e2eMachine`'s transport opens the machine with, unless a test passes its own. */
export const E2E_TICKET = 'a.relay.ticket'

/** A fresh WebCrypto device key, as a browser keeps one. */
export async function testSigner(): Promise<DeviceSigner> {
  return deviceSigner(
    await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']),
  )
}

/** The payload of a device proof. */
export const payloadOf = (proof: string) => JSON.parse(Buffer.from(proof.split('.')[1] ?? '', 'base64url').toString())

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
export type HandshakeAnswer =
  | { kind: 'session'; ttlMs: number }
  | { kind: 'refuse'; status: number; body?: unknown }
  | { kind: 'other key' | 'other hello' | 'bad shape' }

/** How the relay mangles a sealed reply on its way back, if at all. */
export type Tamper = 'bad head' | 'bad body' | 'reorder' | 'truncate' | 'end error' | null

/** How the relay mangles a sealed socket's echo on its way back, if at all. */
export type SocketTamper = 'bad record' | 'replay' | 'reorder' | 'wrong kind' | 'text' | null

/** What the fake machine saw of one sealed request: the outer request as the relay got it, and what was inside. */
export interface SealedSeen {
  headers: Headers
  raw: Uint8Array
  sessionId: string
  channel: number
  inner: E2eHttpRequest
}

/** What the fake machine saw of one sealed socket: the upgrade, every frame as sent, and what was inside. */
export interface SocketSeen {
  url: string
  protocols: string | null
  /** Every message on the real socket, the envelope first, as it crossed the relay. */
  frames: (string | Uint8Array)[]
  sessionId: string
  channel: number
  open: E2eSocketOpen
  /** The page's messages, opened. */
  messages: E2eSocketMessage[]
  /** True once the browser's real socket closed. */
  closed: boolean
}

interface SocketData {
  path: string
  url: string
  protocols: string | null
  /** Settles once every message received so far is handled, in order. */
  queue: Promise<void>
  seen: SocketSeen | null
  channel: E2eChannel | null
  /** The frames before the envelope opened, kept for `seen`. */
  frames: (string | Uint8Array)[]
}

/**
 * A machine behind the relay that answers `routes.e2e.open` as `answer` says, opens sealed requests on their channel
 * and answers them sealed, and records every request and socket in the order they arrive, as
 * `POST /api/e2e/sessions`, `GET /api/health` or `WS /ws/events`. A sealed request's handler answers `ok`, or the
 * chunks in `state.chunks`, after `state.delayMs[path]`; `state.outer` answers the envelope unsealed instead. A sealed
 * socket echoes each message back sealed, mangled as `state.socketTamper` says, or once open closes with
 * `state.socketClose`.
 */
export async function e2eMachine() {
  const machine = await testMachine()
  const impostor = await testMachine()
  const seen: string[] = []
  const sealed: SealedSeen[] = []
  const sockets: SocketSeen[] = []
  const sessions = new Map<string, E2eSession>()
  const state = {
    answer: { kind: 'session', ttlMs: 60_000 } as HandshakeAnswer,
    outer: null as { status: number; body: unknown } | null,
    tamper: null as Tamper,
    chunks: ['ok'],
    delayMs: {} as Record<string, number>,
    socketTamper: null as SocketTamper,
    socketClose: null as number | null,
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

  /** Opens a sealed socket's envelope, or closes it as the host would. */
  const openSocket = async (ws: ServerWebSocket<SocketData>, envelopeBytes: Uint8Array) => {
    const envelope = decodeEnvelope(envelopeBytes)
    const session = sessions.get(envelope.sessionId)
    if (!session) return ws.close(CLOSE_E2E_SESSION_UNKNOWN, 'e2e session unknown')
    const channel = await session.channel(envelope.channel)
    const open = decodeSocketOpenRecord(await channel.open(envelope.sealed))
    const { data } = ws
    data.channel = channel
    data.seen = {
      url: data.url,
      protocols: data.protocols,
      frames: data.frames,
      sessionId: envelope.sessionId,
      channel: envelope.channel,
      open,
      messages: [],
      closed: false,
    }
    sockets.push(data.seen)
    seen.push(`WS ${open.path}`)
    if (state.socketClose !== null) ws.close(state.socketClose, 'closed by the machine')
  }

  /** Echoes `message` back sealed on `channel`, mangled as `state.socketTamper` says. */
  const echo = async (ws: ServerWebSocket<SocketData>, channel: E2eChannel, message: E2eSocketMessage) => {
    const seal = (m: E2eSocketMessage) => channel.seal(encodeSocketMessageRecord(m))
    const tamper = state.socketTamper
    if (tamper === 'text') return ws.send(typeof message === 'string' ? message : 'text')
    if (tamper === 'wrong kind') {
      return ws.send(await channel.seal(encodeSocketOpenRecord(ws.data.seen?.open as E2eSocketOpen)))
    }
    const first = await seal(message)
    if (tamper === 'bad record') first[first.length - 1] = (first[first.length - 1] ?? 0) ^ 1
    if (tamper === 'reorder') {
      const second = await seal('second')
      ws.send(second)
      return ws.send(first)
    }
    ws.send(first)
    if (tamper === 'replay') ws.send(first)
  }

  const server = Bun.serve<SocketData>({
    port: 0,
    hostname: 'localhost',
    async fetch(req, srv) {
      const url = new URL(req.url)
      const path = url.pathname.slice(prefix.length)
      const protocols = req.headers.get('sec-websocket-protocol')
      const data: SocketData = {
        path,
        url: req.url,
        protocols,
        queue: Promise.resolve(),
        seen: null,
        channel: null,
        frames: [],
      }
      if (srv.upgrade(req, { data })) {
        if (path !== '/e2e/ws') seen.push(`WS ${path}`)
        return
      }
      if (path === '/e2e' && req.method === 'POST') return answerSealed(req)
      seen.push(`${req.method} ${path}`)
      if (path === routes.e2e.open.path) return reply(await req.json())
      return new Response('ok')
    },
    websocket: {
      message(ws, message) {
        const { data } = ws
        if (data.path !== '/e2e/ws') return
        const frame = typeof message === 'string' ? message : new Uint8Array(message)
        data.frames.push(frame)
        data.queue = data.queue.then(async () => {
          if (!data.channel) {
            if (typeof frame !== 'string') await openSocket(ws, frame)
            return
          }
          if (typeof frame === 'string') return
          const opened = decodeSocketMessageRecord(await data.channel.open(frame))
          data.seen?.messages.push(opened)
          await echo(ws, data.channel, opened)
        })
      },
      close(ws) {
        if (ws.data.seen) ws.data.seen.closed = true
      },
    },
  })
  servers.push(server)
  const transport = async (options: Partial<RemoteTransportOptions> = {}) =>
    createRemoteTransport({
      serverUrl: `http://localhost:${server.port}`,
      machineId: machine.machineId,
      relayTicket: async () => ({ ticket: E2E_TICKET, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
      device: await testSigner(),
      machinePublicKey: machine.publicKey,
      ...options,
    })
  return { machineId: machine.machineId, seen, sealed, sockets, state, transport, sessions }
}

/** The close code `socket` ends with, or `'open'` once it opens. */
export const outcome = (socket: WebSocket) =>
  new Promise<number | 'open'>((resolve) => {
    socket.onopen = () => {
      resolve('open')
      socket.close()
    }
    socket.onclose = (event) => resolve(event.code)
  })

export const HANDSHAKE = `POST ${routes.e2e.open.path}`
