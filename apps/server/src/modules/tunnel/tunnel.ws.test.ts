import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import {
  CLOSE_HEARTBEAT_TIMEOUT,
  CLOSE_REPLACED,
  CLOSE_UNSUPPORTED_VERSION,
  decodeFrame,
  encodeFrame,
  type MachineFrame,
  machineIdFromPublicKey,
  type ServerFrame,
  serverFrame,
  TUNNEL_PATH,
  TUNNEL_PROTOCOL_VERSION,
} from '@orch/shared'
import type { Server } from 'bun'
import { createApp } from '../../app'
import { serverWebSocket } from '../../lib/websocket'
import { ChannelBridge } from '../bridge/bridge.service'
import { HttpForwarder } from '../forward/forward.service'
import { ConnectionLimiter } from '../limits/limits.service'
import { MachineRegistry } from './tunnel.service'
import { createTestMachineKey, type TestMachineKey } from './tunnel.testing'

const keyA = await createTestMachineKey()
const keyB = await createTestMachineKey()
const timings = { helloTimeoutMs: 150, pingIntervalMs: 30, heartbeatTimeoutMs: 120 }

let registry: MachineRegistry
let server: Server<unknown>
let clients: Machine[]

beforeEach(() => {
  registry = new MachineRegistry()
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: createApp({
      registry,
      forwarder: new HttpForwarder({ registry }),
      bridge: new ChannelBridge({ registry }),
      limiter: new ConnectionLimiter(),
      ...timings,
    }).fetch,
    websocket: serverWebSocket,
  })
  clients = []
})

afterEach(async () => {
  for (const client of clients) client.ws.close()
  await server.stop(true)
})

/** A test machine. With `pong`, it answers every `ping` like a healthy host. */
interface Machine {
  ws: WebSocket
  frames: ServerFrame[]
  raw: string[]
  closed: Promise<{ code: number; reason: string }>
  send(frame: MachineFrame): void
}

async function connect({ pong = false } = {}): Promise<Machine> {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}${TUNNEL_PATH}`)
  const machine: Machine = {
    ws,
    frames: [],
    raw: [],
    closed: new Promise((resolve) => ws.addEventListener('close', (e) => resolve({ code: e.code, reason: e.reason }))),
    send: (frame) => ws.send(encodeFrame(frame)),
  }
  ws.addEventListener('message', (event) => {
    machine.raw.push(String(event.data))
    const frame = decodeFrame(serverFrame, event.data)
    if (!frame) return
    machine.frames.push(frame)
    if (pong && frame.type === 'ping') machine.send({ type: 'pong', nonce: frame.nonce })
  })
  await new Promise((resolve) => ws.addEventListener('open', resolve))
  clients.push(machine)
  return machine
}

async function until(check: () => boolean, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await Bun.sleep(5)
  }
}

/** The nonce of the `challenge` the server sent `machine`, once it has arrived. */
async function challengeOf(machine: Machine): Promise<string> {
  await until(() => machine.frames.some((f) => f.type === 'challenge'))
  const frame = machine.frames.find((f) => f.type === 'challenge')
  return frame?.type === 'challenge' ? frame.nonce : ''
}

/** A welcomed machine: it answers its challenge with `key`'s signed `hello`. */
async function hello(key: TestMachineKey, options?: { pong?: boolean }) {
  const machine = await connect(options)
  machine.send(key.hello(await challengeOf(machine)))
  await until(() => machine.frames.some((f) => f.type === 'welcome'))
  return machine
}

describe('tunnel socket', () => {
  test('challenges each socket, and welcomes a hello signed over it under the hash of its key, logging none of it', async () => {
    const logs = (['log', 'info', 'warn', 'error'] as const).map((method) => spyOn(console, method))
    try {
      const a = await hello(keyA)
      const b = await hello(keyB)
      const [nonceA, nonceB] = [await challengeOf(a), await challengeOf(b)]
      expect(nonceA).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(nonceA).not.toBe(nonceB)
      expect(a.frames.slice(0, 2)).toEqual([
        { type: 'challenge', nonce: nonceA },
        { type: 'welcome', machineId: keyA.machineId },
      ])
      expect(b.frames[1]).toEqual({ type: 'welcome', machineId: keyB.machineId })
      expect(keyA.machineId).toBe(await machineIdFromPublicKey(keyA.publicKey))
      expect(keyA.machineId).not.toBe(keyB.machineId)
      expect(registry.get(keyA.machineId)).toMatchObject({ machineId: keyA.machineId, publicKey: keyA.publicKey })
      expect(registry.size).toBe(2)
      const logged = logs.flatMap((spy) => spy.mock.calls.map((call) => call.join(' ')))
      for (const value of [keyA.publicKey, keyA.privateKey, nonceA, nonceB]) {
        expect(logged.some((text) => text.includes(value))).toBe(false)
      }
      expect([...a.raw, ...b.raw].some((text) => text.includes(keyA.privateKey))).toBe(false)
    } finally {
      for (const spy of logs) spy.mockRestore()
    }
  })

  test('closes with 1008 and registers nothing when the first message is not a hello signed over its own challenge', async () => {
    const other = await connect()
    const otherNonce = await challengeOf(other)
    const firstMessages: ((nonce: string) => string | Uint8Array | null)[] = [
      () => 'not json',
      () => encodeFrame({ type: 'pong', nonce: 1 }),
      () => null,
      // The old shape at the current version.
      () => JSON.stringify({ type: 'hello', version: TUNNEL_PROTOCOL_VERSION, proof: keyA.publicKey }),
      // A signature that does not verify.
      (nonce) => encodeFrame({ ...keyA.hello(nonce), signature: keyB.privateKey.repeat(2).slice(0, 86) }),
      // Signed over another socket's nonce.
      () => encodeFrame(keyA.hello(otherNonce)),
      // A key that did not make the signature.
      (nonce) => encodeFrame({ ...keyA.hello(nonce), publicKey: keyB.publicKey }),
      // Not a point on the curve.
      (nonce) => encodeFrame({ ...keyA.hello(nonce), publicKey: `${'_'.repeat(42)}w` }),
    ]
    for (const message of firstMessages) {
      const machine = await connect()
      const sent = message(await challengeOf(machine))
      if (sent !== null) machine.ws.send(sent)
      expect((await machine.closed).code).toBe(1008)
      expect(registry.size).toBe(0)
    }

    const again = await hello(keyA)
    again.send(keyA.hello(await challengeOf(again)))
    expect((await again.closed).code).toBe(1008)
    await until(() => registry.size === 0)
  })

  test('closes a hello with another protocol version as unsupported, the old version 1 and 2 shapes included', async () => {
    for (const message of [
      JSON.stringify({ type: 'hello', version: 1, proof: `${'A'.repeat(42)}a` }),
      encodeFrame({ ...keyA.hello('n'), version: 2 }),
      encodeFrame({ ...keyA.hello('n'), version: TUNNEL_PROTOCOL_VERSION + 1 }),
    ]) {
      const machine = await connect()
      machine.ws.send(message)
      expect(await machine.closed).toEqual({ code: CLOSE_UNSUPPORTED_VERSION, reason: 'unsupported version' })
      expect(registry.size).toBe(0)
    }
  })

  test('a second connection for the same machine replaces the first, and leaving empties the registry', async () => {
    const id = keyA.machineId
    const old = await hello(keyA, { pong: true })
    const live = registry.get(id)
    const next = await hello(keyA, { pong: true })
    expect(await old.closed).toEqual({ code: CLOSE_REPLACED, reason: 'replaced' })
    // Give the old socket's close event time to reach the server too.
    await Bun.sleep(20)
    expect(registry.get(id)).not.toBe(live)
    expect(registry.get(id)?.machineId).toBe(id)
    expect(registry.size).toBe(1)
    next.ws.close()
    await until(() => registry.size === 0)
  })

  test('drops a silent machine after the heartbeat timeout but keeps one that answers its pings', async () => {
    const silent = await hello(keyA)
    const healthy = await hello(keyB, { pong: true })
    expect(await silent.closed).toEqual({ code: CLOSE_HEARTBEAT_TIMEOUT, reason: 'heartbeat timeout' })
    const pings = silent.frames.filter((f) => f.type === 'ping').map((f) => f.nonce)
    expect(pings.length).toBeGreaterThan(0)
    expect(new Set(pings).size).toBe(pings.length)
    await until(() => registry.get(keyA.machineId) === undefined)

    await Bun.sleep(timings.heartbeatTimeoutMs * 3)
    expect(healthy.ws.readyState).toBe(WebSocket.OPEN)
    expect(registry.get(keyB.machineId)).toBeDefined()

    healthy.send({ type: 'ping', nonce: 77 })
    await until(() => healthy.frames.some((f) => f.type === 'pong'))
    expect(healthy.frames.find((f) => f.type === 'pong')).toEqual({ type: 'pong', nonce: 77 })
  })

  test('remote.off marks the machine once its tunnel closes, and its next hello clears the mark', async () => {
    const id = keyA.machineId
    const machine = await hello(keyA, { pong: true })
    machine.send({ type: 'remote.off' })
    await until(() => registry.isRemoteOff(id))
    machine.ws.close(1000)
    await until(() => registry.get(id) === undefined)
    expect(registry.isRemoteOff(id)).toBe(true)

    await hello(keyA, { pong: true })
    expect(registry.isRemoteOff(id)).toBe(false)
  })

  test('answers enrollment frames with `unavailable` while accounts are off', async () => {
    const machine = await hello(keyA, { pong: true })
    machine.send({ type: 'enroll.preview', id: 1, key: 'oek_any' })
    machine.send({ type: 'enroll.redeem', id: 2, key: 'oek_any', name: 'Box' })
    await until(() => machine.frames.filter((f) => f.type === 'enroll.failed').length === 2)
    expect(machine.frames.filter((f) => f.type === 'enroll.failed')).toEqual([
      { type: 'enroll.failed', id: 1, code: 'unavailable' },
      { type: 'enroll.failed', id: 2, code: 'unavailable' },
    ])
  })
})
