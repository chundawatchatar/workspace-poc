import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from 'bun:test'
import {
  CLOSE_REPLACED,
  CLOSE_UNSUPPORTED_VERSION,
  decodeFrame,
  encodeFrame,
  type MachineFrame,
  machineFrame,
  type ServerFrame,
  TUNNEL_PATH,
  TUNNEL_PROTOCOL_VERSION,
} from '@orch/shared'
import type { Server, ServerWebSocket } from 'bun'
import {
  backoffDelay,
  parseServerUrl,
  TunnelClient,
  type TunnelClientOptions,
  type TunnelTimings,
} from './tunnel.service'

const secret = `${'S'.repeat(42)}s`
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
  closed: { code: number; reason: string } | null
  openedAt: number
}

/**
 * How the fake server treats a socket: `normal` welcomes it and answers pings,
 * `silent` welcomes it then says nothing, `mute` never welcomes it, and a
 * function runs after the welcome.
 */
type Mode = 'normal' | 'silent' | 'mute' | ((conn: Conn, index: number) => void)

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
        conns.push({ ws, frames: [], closed: null, openedAt: Date.now() })
      },
      message(ws, data) {
        const index = conns.findIndex((c) => c.ws === ws)
        const conn = conns[index]
        const frame = decodeFrame(machineFrame, data)
        if (!conn || !frame) return
        conn.frames.push(frame)
        if (frame.type === 'hello') {
          if (mode === 'mute') return
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
  // No log line, from any test, may carry the secret.
  expect(logs.join('\n')).not.toContain(secret)
})

function send(conn: Conn, frame: ServerFrame) {
  conn.ws.send(encodeFrame(frame))
}

function start(options: Partial<TunnelClientOptions> = {}) {
  const url = parseServerUrl(`ws://127.0.0.1:${server.port}`)
  if (!url) throw new Error('rejected the test server URL')
  const client = new TunnelClient({ url, secret, handle: async () => new Response('ok'), timings, ...options })
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

describe('parseServerUrl', () => {
  test('takes wss for any host and ws only for a loopback host', () => {
    expect(parseServerUrl('wss://relay.example.com')).toBe(`wss://relay.example.com${TUNNEL_PATH}`)
    expect(parseServerUrl('wss://relay.example.com:8443/base/')).toBe(`wss://relay.example.com:8443/base${TUNNEL_PATH}`)
    expect(parseServerUrl('ws://127.0.0.1:4600')).toBe(`ws://127.0.0.1:4600${TUNNEL_PATH}`)
    expect(parseServerUrl('ws://[::1]:4600')).toBe(`ws://[::1]:4600${TUNNEL_PATH}`)
    expect(parseServerUrl('ws://localhost:4600')).toBe(`ws://localhost:4600${TUNNEL_PATH}`)
    for (const value of [
      'ws://example.com',
      'ws://10.0.0.1',
      'ws://localhost.example.com',
      'ws://127.0.0.1.example.com',
      'http://127.0.0.1:4600',
      'https://relay.example.com',
      'relay.example.com',
      'wss://',
      'wss://user:pass@relay.example.com',
      '',
    ]) {
      expect(parseServerUrl(value)).toBeNull()
    }
  })
})

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
  test('says hello once, logs the machine id, and keeps both heartbeats', async () => {
    start()
    await until(() => conns[0]?.frames.filter((f) => f.type === 'ping').length >= 2)
    const [conn] = conns
    if (!conn) throw new Error('no connection')
    send(conn, { type: 'ping', nonce: 77 })
    await until(() => conn.frames.some((f) => f.type === 'pong'))

    expect(conn.frames[0]).toEqual({ type: 'hello', version: TUNNEL_PROTOCOL_VERSION, proof: secret })
    expect(conn.frames.filter((f) => f.type === 'hello')).toHaveLength(1)
    const nonces = conn.frames.flatMap((f) => (f.type === 'ping' ? [f.nonce] : []))
    expect(new Set(nonces).size).toBe(nonces.length)
    expect(conn.frames.find((f) => f.type === 'pong')).toEqual({ type: 'pong', nonce: 77 })
    expect(logs).toContain('tunnel connected as machine-0')
  })

  test('replaces a silent server with a new connection, but keeps a live one', async () => {
    start()
    await Bun.sleep(3 * (timings.silenceTimeoutMs ?? 0))
    expect(conns).toHaveLength(1)

    mode = 'silent'
    conns[0]?.ws.close(1000)
    await until(() => conns.length >= 3)
    expect(conns[1]?.closed?.code).toBe(1000)
    expect(conns[2]?.frames[0]).toMatchObject({ type: 'hello' })
  })

  test('gives up on a server that never welcomes and dials again', async () => {
    mode = 'mute'
    start()
    await until(() => conns.length >= 2)
    expect(conns[0]?.closed?.code).toBe(1000)
    expect(conns[1]?.frames).toEqual([{ type: 'hello', version: TUNNEL_PROTOCOL_VERSION, proof: secret }])
  })

  test('stops for good when the server refuses the version or another host takes over', async () => {
    for (const [code, message] of [
      [CLOSE_UNSUPPORTED_VERSION, 'Update this host'],
      [CLOSE_REPLACED, 'another host using this machine secret'],
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

  test('stop closes with 1000 and dials nothing more', async () => {
    const client = start()
    await until(() => logs.includes('tunnel connected as machine-0'))
    client.stop()
    await until(() => conns[0]?.closed !== null)
    await Bun.sleep(50)
    expect(conns).toHaveLength(1)
    expect(conns[0]?.closed?.code).toBe(1000)
  })

  test('drops the requests of a lost connection, and answers ws.open with a close', async () => {
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
    send(first, { type: 'http.request', id: 1, method: 'GET', path: '/api/slow', headers: [] })
    await until(() => first.frames.some((f) => f.type === 'http.body'))
    first.ws.close(1000)
    await until(() => cancelled && conns.length >= 2)
    await until(() => conns[1]?.frames.some((f) => f.type === 'ping') ?? false)

    expect(first.frames.find((f) => f.type === 'ws.close')).toEqual({
      type: 'ws.close',
      channel: 3,
      code: 1011,
      reason: 'not supported',
    })
    expect(signal?.aborted).toBe(true)
    expect(first.frames.filter((f) => f.type.startsWith('http.')).map((f) => f.type)).toEqual([
      'http.response',
      'http.body',
    ])
    expect(conns[1]?.frames.some((f) => f.type.startsWith('http.'))).toBe(false)
  })
})
