import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import {
  CLOSE_MACHINE_OFFLINE,
  decodeFrame,
  encodeFrame,
  type MachineFrame,
  machinePathPrefix,
  type ServerFrame,
  serverFrame,
  TUNNEL_PATH,
  TUNNEL_PROTOCOL_VERSION,
} from '@orch/shared'
import type { Server } from 'bun'
import { createApp } from '../../app'
import { serverWebSocket } from '../../lib/websocket'
import { HttpForwarder } from '../forward/forward.service'
import { MachineRegistry, machineIdFromProof } from '../tunnel/tunnel.service'
import { ChannelBridge } from './bridge.service'

const proofA = `${'A'.repeat(42)}a`
const proofB = `${'B'.repeat(42)}b`
const idA = machineIdFromProof(proofA)

let registry: MachineRegistry
let bridge: ChannelBridge
let server: Server<unknown>
let sockets: WebSocket[]

beforeEach(() => {
  registry = new MachineRegistry()
  bridge = new ChannelBridge({ registry })
  const forwarder = new HttpForwarder({ registry })
  const app = createApp({ registry, forwarder, bridge, pingIntervalMs: 30, heartbeatTimeoutMs: 120 })
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch, websocket: serverWebSocket })
  sockets = []
})

afterEach(async () => {
  for (const ws of sockets) ws.close()
  await server.stop(true)
})

/** A fake machine on `/tunnel` that records the `ws.*` frames it is sent. With `pong`, it answers pings. */
interface Machine {
  ws: WebSocket
  frames: ServerFrame[]
  send(frame: MachineFrame): void
}

async function machine(proof: string, { pong = true } = {}): Promise<Machine> {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}${TUNNEL_PATH}`)
  ws.binaryType = 'arraybuffer'
  sockets.push(ws)
  let welcomed = false
  const m: Machine = { ws, frames: [], send: (frame) => ws.send(encodeFrame(frame)) }
  ws.addEventListener('message', (event) => {
    const frame = decodeFrame(serverFrame, event.data)
    if (frame?.type === 'welcome') welcomed = true
    if (frame?.type.startsWith('ws.')) m.frames.push(frame)
    if (pong && frame?.type === 'ping') m.send({ type: 'pong', nonce: frame.nonce })
  })
  await new Promise((resolve) => ws.addEventListener('open', resolve))
  m.send({ type: 'hello', version: TUNNEL_PROTOCOL_VERSION, proof })
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
  const url = `ws://127.0.0.1:${server.port}${machinePathPrefix(machineId)}${path}`
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
      const m = await machine(proofA)
      const auth = JSON.stringify({ type: 'auth', key: 'secret-key' })
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
      const other = await machine(proofB)
      other.send({ type: 'ws.data', channel: 1, data: 'foreign' })
      await until(() => one.received.length === 2 && two.received.length === 1)
      await Bun.sleep(20)
      expect(one.received).toEqual(['to one', [9, 8]])
      expect(two.received).toEqual(['to two'])
      expect(of(m, 'ws.ack', 1).map((f) => f.bytes)).toEqual([6, 2])

      const logged = logs.flatMap((spy) => spy.mock.calls.map((call) => call.join(' ')))
      expect(logged.some((line) => line.includes('secret-key') || line.includes('term/abc'))).toBe(false)
    } finally {
      for (const spy of logs) spy.mockRestore()
    }
  })

  test('a close on either side closes the other once', async () => {
    const m = await machine(proofA)
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

    m.send({ type: 'ws.close', channel: 3, code: 4100, reason: 'exited' })
    expect(await byMachine.closed).toEqual({ code: 4100, reason: 'exited' })
    await Bun.sleep(20)
    expect(of(m, 'ws.close', 3)).toHaveLength(0)
    expect(bridge.size).toBe(0)
  })

  test('an auth.failed frame keeps the tunnel and the channel open and reaches no browser', async () => {
    const m = await machine(proofA)
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

    const dropped = await machine(proofA)
    const onDropped = browser('/ws/a')
    await opened(onDropped)
    await until(() => bridge.size === 1)
    dropped.ws.close()
    expect((await onDropped.closed).code).toBe(CLOSE_MACHINE_OFFLINE)

    const replaced = await machine(proofA)
    const onReplaced = browser('/ws/a')
    await opened(onReplaced)
    await until(() => of(replaced, 'ws.open').length === 1)
    const next = await machine(proofA)
    expect((await onReplaced.closed).code).toBe(CLOSE_MACHINE_OFFLINE)
    expect(next.frames).toHaveLength(0)

    const silentMachine = await machine(proofB, { pong: false })
    const onSilent = browser('/ws/a', machineIdFromProof(proofB))
    await until(() => of(silentMachine, 'ws.open').length === 1)
    expect((await onSilent.closed).code).toBe(CLOSE_MACHINE_OFFLINE)
    await until(() => silentMachine.ws.readyState === WebSocket.CLOSED)
    expect(bridge.size).toBe(0)
  })

  test('answers 404 to a plain request or a path outside the machine sockets', async () => {
    await machine(proofA)
    const base = `http://127.0.0.1:${server.port}${machinePathPrefix(idA)}`
    expect((await fetch(`${base}/ws/term/a`)).status).toBe(404)
    expect((await fetch(`${base}/ws`)).status).toBe(404)
    expect(bridge.size).toBe(0)
  })
})
