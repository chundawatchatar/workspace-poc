import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from 'bun:test'
import {
  CLOSE_ACCESS_DENIED,
  CLOSE_REPLACED,
  CLOSE_UNSUPPORTED_VERSION,
  decodeFrame,
  encodeFrame,
  type MachineFrame,
  machineFrame,
  parseServerUrl,
  routes,
  type ServerFrame,
  TUNNEL_PATH,
  TUNNEL_PROTOCOL_VERSION,
} from '@orch/shared'
import type { Server, ServerWebSocket } from 'bun'
import { backoffDelay, TunnelClient, type TunnelClientOptions, type TunnelTimings } from './tunnel.service'
import { createTestMachineKey, helloVerifies, testNonce } from './tunnel.testing'

const key = createTestMachineKey()
const timings: Partial<TunnelTimings> = {
  welcomeTimeoutMs: 80,
  pingIntervalMs: 20,
  silenceTimeoutMs: 80,
  stableAfterMs: 5000,
  baseMs: 10,
  maxMs: 10,
}

/** One machine socket as the fake server sees it. */
interface Conn {
  ws: ServerWebSocket<unknown>
  frames: MachineFrame[]
  /** Every message the machine sent, as received. */
  raw: string[]
  /** The nonce of the `challenge` this socket was sent, if any. */
  nonce: string | null
  closed: { code: number; reason: string } | null
  openedAt: number
}

/**
 * How the fake server treats a socket: `normal` challenges it, welcomes a
 * `hello` signed over the challenge and answers pings, `silent` welcomes it
 * then says nothing, `mute` challenges it but never welcomes it, `old` sends
 * no challenge (a server on the previous protocol), and a function runs after
 * the welcome.
 */
type Mode = 'normal' | 'silent' | 'mute' | 'old' | ((conn: Conn, index: number) => void)

let server: Server<unknown>
let conns: Conn[]
let mode: Mode
let clients: TunnelClient[]
let logs: string[]
let spies: Mock<(...args: unknown[]) => void>[]

beforeEach(() => {
  conns = []
  clients = []
  logs = []
  mode = 'normal'
  spies = (['log', 'error', 'warn'] as const).map((level) =>
    spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args.join(' '))),
  )
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, server) {
      if (new URL(request.url).pathname === TUNNEL_PATH && server.upgrade(request, { data: undefined })) return
      return new Response('not found', { status: 404 })
    },
    websocket: {
      open(ws) {
        const nonce = mode === 'old' ? null : testNonce()
        conns.push({ ws, frames: [], raw: [], nonce, closed: null, openedAt: Date.now() })
        if (nonce) ws.send(encodeFrame({ type: 'challenge', nonce }))
      },
      message(ws, data) {
        const index = conns.findIndex((c) => c.ws === ws)
        const conn = conns[index]
        const frame = decodeFrame(machineFrame, data)
        if (!conn) return
        conn.raw.push(typeof data === 'string' ? data : Buffer.from(data).toString('latin1'))
        if (!frame) return
        conn.frames.push(frame)
        if (frame.type === 'hello') {
          if (mode === 'mute' || !conn.nonce || !helloVerifies(frame, conn.nonce)) return
          send(conn, { type: 'welcome', machineId: `machine-${index}` })
          if (typeof mode === 'function') mode(conn, index)
        }
        if (frame.type === 'ping' && mode !== 'silent') send(conn, { type: 'pong', nonce: frame.nonce })
      },
      close(ws, code, reason) {
        const conn = conns.find((c) => c.ws === ws)
        if (conn) conn.closed = { code, reason }
      },
    },
  })
})

afterEach(async () => {
  for (const client of clients) client.stop()
  await server.stop(true)
  for (const spy of spies) spy.mockRestore()
  // No log line, from any test, may carry the private key.
  expect(logs.join('\n')).not.toContain(key.privateKey)
})

function send(conn: Conn, frame: ServerFrame) {
  conn.ws.send(encodeFrame(frame))
}

function start(options: Partial<TunnelClientOptions> = {}) {
  const url = parseServerUrl(`ws://127.0.0.1:${server.port}`)
  if (!url) throw new Error('rejected the test server URL')
  const client = new TunnelClient({
    url,
    key,
    authorize: () => ({ kind: 'account', accountId: 'u1', deviceId: 'd1', ticketExp: 4_102_444_800 }),
    handle: async () => new Response('ok'),
    openSocket: () => ({ code: 1008, reason: 'no sockets here' }),
    timings,
    ...options,
  })
  clients.push(client)
  client.start()
  return client
}

async function until(check: () => boolean, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await Bun.sleep(2)
  }
}

describe('backoffDelay', () => {
  test('doubles from the base up to the cap, scaled by the jitter', () => {
    const one = () => 1
    expect([0, 1, 2, 3, 4, 5, 6, 50].map((attempt) => backoffDelay(attempt, one))).toEqual([
      1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000,
    ])
    expect(backoffDelay(3, () => 0.5)).toBe(4000)
    expect(backoffDelay(10, () => 0)).toBe(0)
  })
})

describe('TunnelClient', () => {
  test('answers the challenge with one signed hello, logs the machine id, and keeps both heartbeats', async () => {
    start({ expectedMachineId: 'machine-expected' })
    await until(() => conns[0]?.frames.filter((f) => f.type === 'ping').length >= 2)
    const [conn] = conns
    if (!conn) throw new Error('no connection')
    send(conn, { type: 'ping', nonce: 77 })
    await until(() => conn.frames.some((f) => f.type === 'pong'))

    const hello = conn.frames[0]
    if (hello?.type !== 'hello' || !conn.nonce) throw new Error('no hello')
    expect(hello).toEqual({
      type: 'hello',
      version: TUNNEL_PROTOCOL_VERSION,
      publicKey: key.publicKey,
      signature: expect.any(String),
    })
    expect(helloVerifies(hello, conn.nonce)).toBe(true)
    expect(conn.frames.filter((f) => f.type === 'hello')).toHaveLength(1)
    // The private key is in no frame the machine sent.
    expect(conn.raw.some((text) => text.includes(key.privateKey))).toBe(false)
    const nonces = conn.frames.flatMap((f) => (f.type === 'ping' ? [f.nonce] : []))
    expect(new Set(nonces).size).toBe(nonces.length)
    expect(conn.frames.find((f) => f.type === 'pong')).toEqual({ type: 'pong', nonce: 77 })
    expect(logs).toContain('tunnel connected as machine-0')
    // The id differs from the one the key implies; the warning names neither.
    const warnings = logs.filter((line) => line.startsWith('warning:'))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).not.toContain('machine-')
  })

  test('replaces a silent server with a new connection, but keeps a live one', async () => {
    start()
    await Bun.sleep(3 * (timings.silenceTimeoutMs ?? 0))
    expect(conns).toHaveLength(1)

    mode = 'silent'
    conns[0]?.ws.close(1000)
    // The third socket can open before its hello arrives, so wait for the frame itself.
    await until(() => (conns[2]?.frames.length ?? 0) > 0)
    expect(conns[1]?.closed?.code).toBe(1000)
    expect(conns[2]?.frames[0]).toMatchObject({ type: 'hello' })
  })

  test('gives up on a server that never welcomes and dials again', async () => {
    mode = 'mute'
    start()
    await until(() => (conns[1]?.frames.length ?? 0) > 0 && conns[0]?.closed !== null)
    expect(conns[0]?.closed?.code).toBe(1000)
    expect(conns[1]?.frames).toMatchObject([{ type: 'hello', version: TUNNEL_PROTOCOL_VERSION }])
  })

  test('sends nothing until the server challenges it, and says why it gives up on a server that never does', async () => {
    mode = 'old'
    start()
    await until(() => (conns[1]?.openedAt ?? 0) > 0 && conns[0]?.closed !== null)
    expect(conns[0]?.frames).toEqual([])
    expect(conns[0]?.closed?.code).toBe(1000)
    expect(logs.some((line) => line.includes('no challenge from server; is it up to date?'))).toBe(true)

    // A welcome without a challenge does not count either.
    const [, second] = conns
    if (!second) throw new Error('no second connection')
    send(second, { type: 'welcome', machineId: 'm' })
    await Bun.sleep(20)
    expect(logs.some((line) => line.startsWith('tunnel connected'))).toBe(false)
  })

  test('stops for good when the server refuses the version or another host takes over', async () => {
    for (const [code, message] of [
      [CLOSE_UNSUPPORTED_VERSION, 'Update this host'],
      [CLOSE_REPLACED, 'another host using this machine key'],
    ] as const) {
      conns = []
      mode = (conn) => conn.ws.close(code, 'bye')
      start()
      await until(() => conns.length === 1 && conns[0]?.closed !== null)
      await Bun.sleep(50)
      expect(conns).toHaveLength(1)
      expect(logs.some((line) => line.includes(message))).toBe(true)
    }
  })

  test('starts the backoff again once a connection has stayed up', async () => {
    // Every connection is closed 60 ms after its welcome, and full jitter is pinned to the top of the window.
    mode = (conn) => setTimeout(() => conn.ws.close(1000), 60)
    start({ random: () => 1, timings: { ...timings, baseMs: 100, maxMs: 10_000, stableAfterMs: 30 } })
    await until(() => conns.length >= 4, 2000)
    const [a = 0, b = 0, c = 0, d = 0] = conns.map((conn) => conn.openedAt)
    // Without the reset, the third gap would be 60 + 400 ms.
    for (const gap of [b - a, c - b, d - c]) expect(gap).toBeLessThan(300)
  })

  test('reports connecting, connected, reconnecting, stopped and off as the tunnel goes through them', async () => {
    const seen: string[] = []
    mode = 'mute'
    const client = start({
      random: () => 1,
      timings: { ...timings, welcomeTimeoutMs: 2000, baseMs: 100, maxMs: 100 },
      onStatus: (state) => seen.push(state),
    })
    await until(() => conns[0]?.frames.some((f) => f.type === 'hello') ?? false)
    expect(client.status).toBe('connecting')

    const [first] = conns
    if (!first) throw new Error('no connection')
    send(first, { type: 'welcome', machineId: 'm' })
    await until(() => client.status === 'connected')

    mode = (conn) => conn.ws.close(CLOSE_REPLACED, 'bye')
    first.ws.close(1000)
    await until(() => client.status === 'reconnecting')
    await until(() => client.status === 'stopped')

    client.stop()
    expect(client.status).toBe('off')
    expect(seen).toEqual(['connecting', 'connected', 'reconnecting', 'connecting', 'connected', 'stopped', 'off'])
  })

  test('stop closes with 1000 and dials nothing more', async () => {
    const client = start()
    await until(() => logs.includes('tunnel connected as machine-0'))
    client.stop()
    await until(() => conns[0]?.closed !== null)
    await Bun.sleep(50)
    expect(conns).toHaveLength(1)
    expect(conns[0]?.closed?.code).toBe(1000)
  })

  test('stop with remoteOff sends one remote.off before the 1000 close, and a plain stop sends none', async () => {
    const off = start()
    await until(() => logs.includes('tunnel connected as machine-0'))
    off.stop({ remoteOff: true })
    await until(() => conns[0]?.closed !== null)
    expect(conns[0]?.frames.filter((f) => f.type === 'remote.off')).toHaveLength(1)
    expect(conns[0]?.frames.at(-1)).toEqual({ type: 'remote.off' })
    expect(conns[0]?.closed?.code).toBe(1000)

    const plain = start()
    await until(() => logs.includes('tunnel connected as machine-1'))
    plain.stop()
    await until(() => conns[1]?.closed !== null)
    expect(conns[1]?.frames.some((f) => f.type === 'remote.off')).toBe(false)
    expect(conns[1]?.closed?.code).toBe(1000)
  })

  test('enroll waits for the owner after enroll.waiting, unlink answers at once, and both reject before welcome, on timeout and on a lost tunnel', async () => {
    const key = `oek_${'k'.repeat(43)}`
    const email = 'ada@example.com'
    const account = { name: 'Ada', maskedEmail: 'a***@example.com' }
    const relayKeys = [{ kid: 'k1', publicKey: 'P'.repeat(43) }]
    const request = { type: 'enroll.request', key, email, name: 'box' } as const
    mode = 'mute'
    const client = start({ timings: { ...timings, welcomeTimeoutMs: 2000, askTimeoutMs: 60 } })
    await until(() => conns[0]?.frames.some((f) => f.type === 'hello') ?? false)
    await expect(client.enroll(request)).rejects.toThrow('not connected')
    await expect(client.unlink('u1')).rejects.toThrow('not connected')

    const [conn] = conns
    if (!conn) throw new Error('no connection')
    send(conn, { type: 'welcome', machineId: 'm' })
    await until(() => client.status === 'connected')
    const sent = () => conn.frames.flatMap((f) => (f.type === 'enroll.request' || f.type === 'unlink' ? [f] : []))
    /** The id of the `n`th asking frame the client sent, once it has. */
    const idOf = async (n: number) => {
      await until(() => sent().length > n)
      return sent()[n]?.id ?? 0
    }
    const asked = client.enroll(request)
    const unlink = client.unlink('u1')
    const [r, u] = [await idOf(0), await idOf(1)]
    expect(sent()).toEqual([
      { ...request, id: r },
      { type: 'unlink', id: u, accountId: 'u1' },
    ])
    expect(r).not.toBe(u)
    // An answer of the wrong kind for the id is ignored, as is a final answer before the request waits.
    send(conn, { type: 'enroll.waiting', id: u, expiresInMs: 5000 })
    send(conn, { type: 'unlinked', id: r })
    send(conn, { type: 'enroll.redeemed', id: r, machineId: 'm', accountId: 'u1', account, relayKeys })
    send(conn, { type: 'unlinked', id: u })
    send(conn, { type: 'enroll.waiting', id: r, expiresInMs: 5000 })
    const waiting = await asked
    expect(waiting).toMatchObject({ type: 'enroll.waiting', id: r, expiresInMs: 5000 })
    if (waiting.type !== 'enroll.waiting') throw new Error('not waiting')
    expect(await unlink).toEqual({ type: 'unlinked', id: u })

    // The owner's answer has no time limit but the connection's, and a second waiting is ignored.
    await Bun.sleep(100)
    send(conn, { type: 'enroll.waiting', id: r, expiresInMs: 1 })
    send(conn, { type: 'enroll.failed', id: r, code: 'rejected' })
    expect(await waiting.answer).toEqual({ type: 'enroll.failed', id: r, code: 'rejected' })

    // A failed first answer resolves at once, and an unanswered ask times out.
    const refused = client.enroll(request)
    send(conn, { type: 'enroll.failed', id: await idOf(2), code: 'rate_limited' })
    expect(await refused).toMatchObject({ type: 'enroll.failed', code: 'rate_limited' })
    await expect(client.unlink('u1')).rejects.toThrow('did not answer')

    // A lost tunnel rejects a request on its way and the owner's answer to one that waits.
    const held = client.enroll(request)
    send(conn, { type: 'enroll.waiting', id: await idOf(4), expiresInMs: 5000 })
    const heldWaiting = await held
    if (heldWaiting.type !== 'enroll.waiting') throw new Error('not waiting')
    const lost = client.enroll(request)
    await idOf(5)
    conn.ws.close(1000)
    await expect(lost).rejects.toThrow('closed')
    await expect(heldWaiting.answer).rejects.toThrow('closed')
    expect(logs.join('\n')).not.toContain(key)
    expect(logs.join('\n')).not.toContain(email)
  })

  test('whenConnected resolves on the welcome, and rejects when the first attempt fails or the client stops', async () => {
    const client = start()
    await client.whenConnected(1000)
    expect(client.status).toBe('connected')
    await client.whenConnected(1000)

    const probe = Bun.serve({ port: 0, fetch: () => new Response('') })
    const nowhere = new TunnelClient({
      url: parseServerUrl(`ws://127.0.0.1:${probe.port}`) ?? '',
      key,
      authorize: () => null,
      handle: async () => new Response('ok'),
      openSocket: () => ({ code: 1008, reason: 'none' }),
      timings,
    })
    probe.stop(true)
    clients.push(nowhere)
    nowhere.start()
    await expect(nowhere.whenConnected(1000)).rejects.toThrow('reconnecting')

    mode = 'mute'
    const muted = start()
    const waiting = muted.whenConnected(1000)
    muted.stop()
    await expect(waiting).rejects.toThrow('off')
    await expect(muted.whenConnected(1000)).rejects.toThrow('off')
  })

  test('passes session.ended on only after welcome, and ignores a malformed one without dropping the tunnel', async () => {
    mode = 'mute'
    const ended: string[] = []
    const client = start({ onSessionEnded: (accountId) => ended.push(accountId) })
    await until(() => conns[0]?.frames.some((f) => f.type === 'hello') ?? false)
    const [conn] = conns
    if (!conn) throw new Error('no connection')
    send(conn, { type: 'session.ended', accountId: 'too-early' })
    send(conn, { type: 'welcome', machineId: 'machine-0' })
    await until(() => client.status === 'connected')
    conn.ws.send(JSON.stringify({ type: 'session.ended', accountId: 'with-extra', sessionId: 's1' }))
    send(conn, { type: 'session.ended', accountId: 'acct-1' })
    await until(() => ended.length > 0)

    expect(ended).toEqual(['acct-1'])
    expect(client.status).toBe('connected')
    expect(conns).toHaveLength(1)
    expect(conn.closed).toBeNull()
  })

  test('drops the requests of a lost connection, and answers a plain ws.open with a close', async () => {
    let signal: AbortSignal | undefined
    let cancelled = false
    start({
      handle: async (request) => {
        signal = request.signal
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('first'))
            },
            cancel() {
              cancelled = true
            },
          }),
        )
      },
    })
    await until(() => conns[0]?.frames.some((f) => f.type === 'ping') ?? false)
    const [first] = conns
    if (!first) throw new Error('no connection')
    first.ws.send('not a frame')
    send(first, { type: 'ws.data', channel: 1, data: 'x' })
    send(first, { type: 'ws.open', channel: 3, path: '/ws/events', headers: [] })
    send(first, { type: 'ws.data', channel: 3, data: JSON.stringify({ type: 'auth', key: 'k', device: 'p' }) })
    send(first, { type: 'http.request', id: 1, method: 'GET', path: routes.system.machineKey.path, headers: [] })
    await until(() => first.frames.some((f) => f.type === 'http.body'))
    first.ws.close(1000)
    await until(() => cancelled && conns.length >= 2)
    await until(() => conns[1]?.frames.some((f) => f.type === 'ping') ?? false)

    expect(first.frames.find((f) => f.type === 'ws.close')).toEqual({
      type: 'ws.close',
      channel: 3,
      code: CLOSE_ACCESS_DENIED,
      reason: 'end-to-end encryption required',
    })
    expect(signal?.aborted).toBe(true)
    expect(first.frames.filter((f) => f.type.startsWith('http.')).map((f) => f.type)).toEqual([
      'http.response',
      'http.body',
    ])
    expect(conns[1]?.frames.some((f) => f.type.startsWith('http.'))).toBe(false)
  })
})
