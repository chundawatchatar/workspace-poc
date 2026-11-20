import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, spyOn, test } from 'bun:test'
import { connect, type Socket } from 'node:net'
import { createTestDomain, type TestDomain } from '@orch/domain/testing'
import {
  type AgentState,
  CLOSE_DEVICE_NOT_APPROVED,
  CLOSE_MACHINE_OFFLINE,
  decodeFrame,
  encodeFrame,
  MAX_E2E_ENVELOPE_BYTES,
  type MachineFrame,
  machinePathPrefix,
  machineSealedSocketPath,
  type ServerEvent,
  type ServerFrame,
  type SessionInfo,
  serverFrame,
  TUNNEL_PATH,
} from '@orch/shared'
import type { Server } from 'bun'
import { createApp } from '../../app'
import { serverWebSocket } from '../../lib/websocket'
import { accountsTestDeps } from '../auth/auth.testing'
import { HttpForwarder } from '../forward/forward.service'
import { ConnectionLimiter } from '../limits/limits.service'
import { MachineRegistry } from '../tunnel/tunnel.service'
import { answerChallenge, createTestMachineKey, type TestMachineKey } from '../tunnel/tunnel.testing'
import { ChannelBridge } from './bridge.service'

const keyA = await createTestMachineKey()
const keyB = await createTestMachineKey()
const idA = keyA.machineId

let registry: MachineRegistry
let bridge: ChannelBridge
let limiter: ConnectionLimiter
let server: Server<unknown>
let sockets: WebSocket[]

let domain: TestDomain

beforeAll(async () => {
  domain = await createTestDomain({ log: () => {} })
})

afterAll(async () => {
  await domain.close()
})

beforeEach(() => {
  registry = new MachineRegistry()
  bridge = new ChannelBridge({ registry })
  limiter = new ConnectionLimiter()
  const forwarder = new HttpForwarder({ registry })
  const app = createApp({
    registry,
    ...accountsTestDeps(domain, registry).deps,
    forwarder,
    bridge,
    limiter,
    pingIntervalMs: 30,
    heartbeatTimeoutMs: 120,
  })
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch, websocket: serverWebSocket })
  sockets = []
})

afterEach(async () => {
  jest.useRealTimers()
  for (const ws of sockets) ws.close()
  await server.stop(true)
})

/** A fake machine on `/tunnel` that records the `ws.*` frames it is sent. With `pong`, it answers pings. */
interface Machine {
  ws: WebSocket
  frames: ServerFrame[]
  send(frame: MachineFrame): void
}

async function machine(key: TestMachineKey, { pong = true } = {}): Promise<Machine> {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}${TUNNEL_PATH}`)
  ws.binaryType = 'arraybuffer'
  sockets.push(ws)
  answerChallenge(ws, key)
  let welcomed = false
  const m: Machine = { ws, frames: [], send: (frame) => ws.send(encodeFrame(frame)) }
  ws.addEventListener('message', (event) => {
    const frame = decodeFrame(serverFrame, event.data)
    if (frame?.type === 'welcome') welcomed = true
    if (frame?.type.startsWith('ws.')) m.frames.push(frame)
    if (pong && frame?.type === 'ping') m.send({ type: 'pong', nonce: frame.nonce })
  })
  await until(() => welcomed)
  return m
}

/** A browser socket to a machine path, recording what it receives and how it closes. */
interface Browser {
  ws: WebSocket
  received: (string | number[])[]
  closed: Promise<{ code: number; reason: string }>
}

function browser(path: string, machineId = idA, headers?: Record<string, string>): Browser {
  return browserAt(`${machinePathPrefix(machineId)}${path}`, headers)
}

/** A browser socket to a sealed socket route, as `browser`. */
function sealedBrowser(machineId = idA, headers?: Record<string, string>): Browser {
  return browserAt(machineSealedSocketPath(machineId), headers)
}

function browserAt(serverPath: string, headers?: Record<string, string>): Browser {
  const url = `ws://127.0.0.1:${server.port}${serverPath}`
  const ws = new WebSocket(url, headers ? { headers } : undefined)
  ws.binaryType = 'arraybuffer'
  sockets.push(ws)
  const b: Browser = {
    ws,
    received: [],
    closed: new Promise((resolve) => ws.addEventListener('close', (e) => resolve({ code: e.code, reason: e.reason }))),
  }
  ws.addEventListener('message', (event) => {
    b.received.push(typeof event.data === 'string' ? event.data : [...new Uint8Array(event.data as ArrayBuffer)])
  })
  return b
}

/**
 * Sends a socket upgrade by hand, so the request can carry a `Cookie` header and
 * the 101 head can be read. Resolves with the head once it has arrived.
 */
async function rawUpgrade(path: string, headers: Record<string, string>): Promise<{ socket: Socket; head: string }> {
  const socket = connect(server.port as number, '127.0.0.1')
  let received = ''
  const head = new Promise<string>((resolve, reject) => {
    socket.on('data', (chunk) => {
      received += chunk.toString('latin1')
      const end = received.indexOf('\r\n\r\n')
      if (end >= 0) resolve(received.slice(0, end))
    })
    socket.on('error', reject)
  })
  const lines = [
    `GET ${machinePathPrefix(idA)}${path} HTTP/1.1`,
    `Host: 127.0.0.1:${server.port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Version: 13',
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
  ]
  socket.write(`${lines.join('\r\n')}\r\n\r\n`)
  return { socket, head: await head }
}

const opened = (b: Browser) => new Promise((resolve) => b.ws.addEventListener('open', resolve))

async function until(check: () => boolean, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await Bun.sleep(5)
  }
}

function of<T extends ServerFrame['type']>(m: Machine, type: T, channel?: number) {
  return m.frames.filter(
    (f): f is Extract<ServerFrame, { type: T }> =>
      f.type === type && (channel === undefined || ('channel' in f && f.channel === channel)),
  )
}

describe('bridge socket', () => {
  test('relays the path, headers and messages of each socket on its own channel, untouched', async () => {
    const logs = (['log', 'info', 'warn', 'error'] as const).map((method) => spyOn(console, method))
    try {
      const m = await machine(keyA)
      // The auth message, with its device proof, is the machine's to read, so it passes through as sent.
      const auth = JSON.stringify({ type: 'auth', account: true, device: 'a.device.proof' })
      const one = browser('/ws/term/abc?cols=80&name=a%20b', idA, { 'x-thing': 'a' })
      await opened(one)
      one.ws.send(auth)
      one.ws.send(new Uint8Array([0, 1, 255]))
      one.ws.send('é')
      await until(() => of(m, 'ws.data').length === 3)

      const [open] = of(m, 'ws.open')
      expect(open).toMatchObject({ channel: 1, path: '/ws/term/abc?cols=80&name=a%20b' })
      expect(open?.headers).toContainEqual(['x-thing', 'a'])
      const dropped = ['host', 'connection', 'upgrade', 'sec-websocket-key', 'sec-websocket-version']
      expect(open?.headers.some(([name]) => dropped.includes(name) || name === 'sec-websocket-extensions')).toBe(false)
      expect(of(m, 'ws.data').map((f) => (typeof f.data === 'string' ? f.data : [...f.data]))).toEqual([
        auth,
        [0, 1, 255],
        'é',
      ])

      const two = browser('/ws/events')
      await opened(two)
      await until(() => of(m, 'ws.open').length === 2)
      expect(of(m, 'ws.open')[1]?.channel).toBe(2)
      two.ws.send('only two')
      await until(() => of(m, 'ws.data', 2).length === 1)
      expect(of(m, 'ws.data', 1)).toHaveLength(3)

      m.send({ type: 'ws.data', channel: 1, data: 'to one' })
      m.send({ type: 'ws.data', channel: 1, data: new Uint8Array([9, 8]) })
      m.send({ type: 'ws.data', channel: 2, data: 'to two' })
      m.send({ type: 'ws.data', channel: 77, data: 'nobody' })
      // Another machine's tunnel may use the same channel ids.
      const other = await machine(keyB)
      other.send({ type: 'ws.data', channel: 1, data: 'foreign' })
      await until(() => one.received.length === 2 && two.received.length === 1)
      await Bun.sleep(20)
      expect(one.received).toEqual(['to one', [9, 8]])
      expect(two.received).toEqual(['to two'])
      expect(of(m, 'ws.ack', 1).map((f) => f.bytes)).toEqual([6, 2])

      const logged = logs.flatMap((spy) => spy.mock.calls.map((call) => call.join(' ')))
      expect(logged.some((line) => line.includes('a.device.proof') || line.includes('term/abc'))).toBe(false)
    } finally {
      for (const spy of logs) spy.mockRestore()
    }
  })

  test('never relays the account cookies to the machine, and the upgrade response sets none', async () => {
    const m = await machine(keyA)
    const { socket, head } = await rawUpgrade('/ws/events', {
      Cookie: 'session=abc',
      'x-thing': 'a',
      'Sec-WebSocket-Protocol': 'orch',
    })
    try {
      expect(head.split('\r\n')[0]).toContain(' 101 ')
      expect(head.split('\r\n').some((line) => line.toLowerCase().startsWith('set-cookie:'))).toBe(false)
      await until(() => of(m, 'ws.open').length === 1)
      const [open] = of(m, 'ws.open')
      expect(open?.headers).toContainEqual(['x-thing', 'a'])
      expect(open?.headers).toContainEqual(['sec-websocket-protocol', 'orch'])
      expect(open?.headers.some(([name]) => name.toLowerCase() === 'cookie')).toBe(false)
    } finally {
      socket.destroy()
    }
  })

  test('a close on either side closes the other once', async () => {
    const m = await machine(keyA)
    const byBrowser = browser('/ws/a')
    const bare = browser('/ws/b')
    const byMachine = browser('/ws/c')
    await Promise.all([opened(byBrowser), opened(bare), opened(byMachine)])
    await until(() => of(m, 'ws.open').length === 3)

    byBrowser.ws.close(4001, 'bye')
    bare.ws.close()
    await until(() => of(m, 'ws.close').length === 2)
    expect(of(m, 'ws.close', 1)).toEqual([{ type: 'ws.close', channel: 1, code: 4001, reason: 'bye' }])
    // Bun's client sends 1000 for a bare `close()`, so the no-code case is left to the service test.
    expect(of(m, 'ws.close', 2)).toEqual([{ type: 'ws.close', channel: 2, code: 1000 }])

    // Any close code from 3000 to 4999 passes through, such as a device waiting for approval.
    m.send({ type: 'ws.close', channel: 3, code: CLOSE_DEVICE_NOT_APPROVED, reason: 'device not approved' })
    expect(await byMachine.closed).toEqual({ code: CLOSE_DEVICE_NOT_APPROVED, reason: 'device not approved' })
    await Bun.sleep(20)
    expect(of(m, 'ws.close', 3)).toHaveLength(0)
    expect(bridge.size).toBe(0)
  })

  test("carries a session event's agent state to the browser unchanged", async () => {
    const m = await machine(keyA)
    const b = browser('/ws/events')
    await opened(b)
    await until(() => of(m, 'ws.open').length === 1)

    const agentState: AgentState = { state: 'working', reason: 'turn', since: 1_700_000_000_000 }
    const session: SessionInfo = {
      id: 's1',
      title: 'claude',
      alive: true,
      attention: null,
      process: null,
      cwd: '/repo',
      progress: 'busy',
      agent: { kind: 'claude', sessionId: null, cwd: '/repo' },
      interrupted: null,
      agentState,
      agentTracking: true,
    }
    const sent = JSON.stringify({ type: 'session', session } satisfies ServerEvent)
    m.send({ type: 'ws.data', channel: 1, data: sent })
    await until(() => b.received.length === 1)
    expect(b.received).toEqual([sent])
    expect(JSON.parse(b.received[0] as string).session.agentState).toEqual(agentState)
  })

  test('an auth.failed frame keeps the tunnel and the channel open and reaches no browser', async () => {
    const m = await machine(keyA)
    const b = browser('/ws/events')
    await opened(b)
    await until(() => of(m, 'ws.open').length === 1)

    m.send({ type: 'auth.failed', channel: 1 })
    m.send({ type: 'auth.failed', id: 5 })
    m.send({ type: 'ws.data', channel: 1, data: 'still here' })
    await until(() => b.received.length > 0)
    expect(b.received).toEqual(['still here'])
    expect(m.ws.readyState).toBe(WebSocket.OPEN)
    expect(bridge.size).toBe(1)
  })

  test('closes sockets with machine offline when there is no tunnel, or when it drops or times out', async () => {
    const offline = browser('/ws/a')
    expect((await offline.closed).code).toBe(CLOSE_MACHINE_OFFLINE)

    const dropped = await machine(keyA)
    const onDropped = browser('/ws/a')
    await opened(onDropped)
    await until(() => bridge.size === 1)
    dropped.ws.close()
    expect((await onDropped.closed).code).toBe(CLOSE_MACHINE_OFFLINE)

    const replaced = await machine(keyA)
    const onReplaced = browser('/ws/a')
    await opened(onReplaced)
    await until(() => of(replaced, 'ws.open').length === 1)
    const next = await machine(keyA)
    expect((await onReplaced.closed).code).toBe(CLOSE_MACHINE_OFFLINE)
    expect(next.frames).toHaveLength(0)

    const silentMachine = await machine(keyB, { pong: false })
    const onSilent = browser('/ws/a', keyB.machineId)
    await until(() => of(silentMachine, 'ws.open').length === 1)
    expect((await onSilent.closed).code).toBe(CLOSE_MACHINE_OFFLINE)
    await until(() => silentMachine.ws.readyState === WebSocket.CLOSED)
    expect(bridge.size).toBe(0)
  })

  test('answers 404 to a plain request or a path outside the machine sockets', async () => {
    await machine(keyA)
    const base = `http://127.0.0.1:${server.port}${machinePathPrefix(idA)}`
    expect((await fetch(`${base}/ws/term/a`)).status).toBe(404)
    expect((await fetch(`${base}/ws`)).status).toBe(404)
    expect(bridge.size).toBe(0)
  })

  test('a sealed socket sends its first message unread as one ws.sealed, with no path, header or subprotocol', async () => {
    const m = await machine(keyA)
    const b = sealedBrowser(idA, { Cookie: 'session=abc', 'Sec-WebSocket-Protocol': 'orch', 'x-thing': 'a' })
    await opened(b)
    const envelope = Uint8Array.from({ length: 300 }, (_, i) => i % 256)
    b.ws.send(envelope)
    b.ws.send(Uint8Array.of(7, 7))
    await until(() => of(m, 'ws.data').length === 1)

    expect(m.frames).toEqual([
      { type: 'ws.sealed', channel: 1, data: envelope },
      { type: 'ws.data', channel: 1, data: Uint8Array.of(7, 7) },
    ])
    expect(Object.keys(m.frames[0] ?? {}).sort()).toEqual(['channel', 'data', 'type'])

    m.send({ type: 'ws.data', channel: 1, data: Uint8Array.of(9, 9, 9) })
    await until(() => b.received.length === 1)
    expect(b.received).toEqual([[9, 9, 9]])
    expect(of(m, 'ws.ack', 1)).toEqual([{ type: 'ws.ack', channel: 1, bytes: 3 }])

    // The machine refuses the channel's credentials: the browser's IP is charged once, then the close passes through.
    const badKey = spyOn(limiter, 'badKey')
    m.send({ type: 'auth.failed', channel: 1 })
    m.send({ type: 'auth.failed', channel: 1 })
    m.send({ type: 'ws.close', channel: 1, code: 4401, reason: 'access denied' })
    expect(await b.closed).toEqual({ code: 4401, reason: 'access denied' })
    expect(badKey).toHaveBeenCalledTimes(1)
    b.ws.close()
    await Bun.sleep(20)
    expect(of(m, 'ws.close')).toHaveLength(0)
    expect(bridge.size).toBe(0)
  })

  test('a sealed socket whose first message is text or too large is closed with 1008, and nothing reaches the machine', async () => {
    const m = await machine(keyA)
    const text = sealedBrowser()
    await opened(text)
    text.ws.send('{"type":"auth"}')
    const large = sealedBrowser()
    await opened(large)
    large.ws.send(new Uint8Array(MAX_E2E_ENVELOPE_BYTES + 1))
    expect([(await text.closed).code, (await large.closed).code]).toEqual([1008, 1008])
    await Bun.sleep(20)
    expect(m.frames).toEqual([])
    expect(bridge.size).toBe(0)

    // An offline machine closes it as for a plain socket.
    const offline = sealedBrowser(keyB.machineId)
    await opened(offline)
    offline.ws.send(new Uint8Array(64))
    expect((await offline.closed).code).toBe(CLOSE_MACHINE_OFFLINE)
  })

  test('a sealed socket that sends nothing for 10 seconds is closed with 1008', async () => {
    const m = await machine(keyA)
    jest.useFakeTimers()
    const b = sealedBrowser()
    await opened(b)
    jest.advanceTimersByTime(9_999)
    expect(b.ws.readyState).toBe(WebSocket.OPEN)
    jest.advanceTimersByTime(1)
    expect((await b.closed).code).toBe(1008)
    jest.useRealTimers()
    expect(m.frames).toEqual([])
    expect(bridge.size).toBe(0)
  })
})
