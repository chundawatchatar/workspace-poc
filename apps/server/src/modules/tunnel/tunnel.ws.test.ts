import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { websocket } from '@hono/bun'
import {
  decodeFrame,
  encodeFrame,
  type MachineFrame,
  type ServerFrame,
  serverFrame,
  TUNNEL_PATH,
  TUNNEL_PROTOCOL_VERSION,
} from '@orch/shared'
import type { Server } from 'bun'
import { createApp } from '../../app'
import { HttpForwarder } from '../forward/forward.service'
import { MachineRegistry, machineIdFromProof } from './tunnel.service'
import { CLOSE_HEARTBEAT_TIMEOUT, CLOSE_REPLACED, CLOSE_UNSUPPORTED_VERSION } from './tunnel.ws'

const proofA = `${'A'.repeat(42)}a`
const proofB = `${'B'.repeat(42)}b`
const timings = { helloTimeoutMs: 150, pingIntervalMs: 30, heartbeatTimeoutMs: 120 }

let registry: MachineRegistry
let server: Server<unknown>
let clients: Machine[]

beforeEach(() => {
  registry = new MachineRegistry()
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: createApp({ registry, forwarder: new HttpForwarder({ registry }), ...timings }).fetch,
    websocket,
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

async function hello(proof: string, options?: { pong?: boolean }) {
  const machine = await connect(options)
  machine.send({ type: 'hello', version: TUNNEL_PROTOCOL_VERSION, proof })
  await until(() => machine.frames.some((f) => f.type === 'welcome'))
  return machine
}

describe('tunnel socket', () => {
  test('welcomes a valid hello with the id derived from its proof, without ever logging or echoing the proof', async () => {
    const logs = (['log', 'info', 'warn', 'error'] as const).map((method) => spyOn(console, method))
    try {
      const a = await hello(proofA)
      const b = await hello(proofB)
      const idA = machineIdFromProof(proofA)
      expect(a.frames[0]).toEqual({ type: 'welcome', machineId: idA })
      expect(b.frames[0]).toEqual({ type: 'welcome', machineId: machineIdFromProof(proofB) })
      expect(idA).not.toBe(machineIdFromProof(proofB))
      expect(registry.get(idA)?.machineId).toBe(idA)
      expect(registry.size).toBe(2)
      const seen = [...a.raw, ...b.raw, ...logs.flatMap((spy) => spy.mock.calls.map((call) => call.join(' ')))]
      expect(seen.some((text) => text.includes(proofA) || text.includes(proofB))).toBe(false)
    } finally {
      for (const spy of logs) spy.mockRestore()
    }
  })

  test('closes with 1008 and registers nothing when the first message is not a valid hello', async () => {
    const firstMessages = [
      'not json',
      encodeFrame({ type: 'pong', nonce: 1 }),
      JSON.stringify({ type: 'hello', version: TUNNEL_PROTOCOL_VERSION, proof: 'short' }),
      null,
    ]
    for (const message of firstMessages) {
      const machine = await connect()
      if (message !== null) machine.ws.send(message)
      expect((await machine.closed).code).toBe(1008)
      expect(registry.size).toBe(0)
    }

    const again = await hello(proofA)
    again.send({ type: 'hello', version: TUNNEL_PROTOCOL_VERSION, proof: proofA })
    expect((await again.closed).code).toBe(1008)
    await until(() => registry.size === 0)
  })

  test('closes a hello with another protocol version as unsupported', async () => {
    const machine = await connect()
    machine.send({ type: 'hello', version: TUNNEL_PROTOCOL_VERSION + 1, proof: proofA })
    expect(await machine.closed).toEqual({ code: CLOSE_UNSUPPORTED_VERSION, reason: 'unsupported version' })
    expect(registry.size).toBe(0)
  })

  test('a second connection for the same machine replaces the first, and leaving empties the registry', async () => {
    const id = machineIdFromProof(proofA)
    const old = await hello(proofA, { pong: true })
    const live = registry.get(id)
    const next = await hello(proofA, { pong: true })
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
    const silent = await hello(proofA)
    const healthy = await hello(proofB, { pong: true })
    expect(await silent.closed).toEqual({ code: CLOSE_HEARTBEAT_TIMEOUT, reason: 'heartbeat timeout' })
    const pings = silent.frames.filter((f) => f.type === 'ping').map((f) => f.nonce)
    expect(pings.length).toBeGreaterThan(0)
    expect(new Set(pings).size).toBe(pings.length)
    await until(() => registry.get(machineIdFromProof(proofA)) === undefined)

    await Bun.sleep(timings.heartbeatTimeoutMs * 3)
    expect(healthy.ws.readyState).toBe(WebSocket.OPEN)
    expect(registry.get(machineIdFromProof(proofB))).toBeDefined()

    healthy.send({ type: 'ping', nonce: 77 })
    await until(() => healthy.frames.some((f) => f.type === 'pong'))
    expect(healthy.frames.find((f) => f.type === 'pong')).toEqual({ type: 'pong', nonce: 77 })
  })
})
