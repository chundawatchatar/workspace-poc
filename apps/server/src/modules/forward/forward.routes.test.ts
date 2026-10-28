import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import {
  ACCESS_KEY_HEADER,
  decodeFrame,
  encodeFrame,
  MAX_TUNNEL_FRAME_BYTES,
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
import { ChannelBridge } from '../bridge/bridge.service'
import { MachineRegistry, machineIdFromProof } from '../tunnel/tunnel.service'
import { HttpForwarder } from './forward.service'

const proofA = `${'A'.repeat(42)}a`
const proofB = `${'B'.repeat(42)}b`
const idA = machineIdFromProof(proofA)
const encoder = new TextEncoder()

let registry: MachineRegistry
let forwarder: HttpForwarder
let server: Server<unknown>
let machines: Machine[]

beforeEach(() => {
  registry = new MachineRegistry()
  forwarder = new HttpForwarder({ registry, requestTimeoutMs: 1000 })
  const app = createApp({
    registry,
    forwarder,
    bridge: new ChannelBridge({ registry }),
    pingIntervalMs: 30,
    heartbeatTimeoutMs: 120,
  })
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch, websocket: serverWebSocket })
  machines = []
})

afterEach(async () => {
  for (const machine of machines) machine.ws.close()
  await server.stop(true)
})

/** A fake machine on `/tunnel` that records the requests it is sent. With `pong`, it answers pings. */
interface Machine {
  ws: WebSocket
  requests: Extract<ServerFrame, { type: 'http.request' }>[]
  send(frame: MachineFrame): void
}

async function machine(proof: string, { pong = true } = {}): Promise<Machine> {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}${TUNNEL_PATH}`)
  ws.binaryType = 'arraybuffer'
  let welcomed = false
  const m: Machine = { ws, requests: [], send: (frame) => ws.send(encodeFrame(frame)) }
  ws.addEventListener('message', (event) => {
    const frame = decodeFrame(serverFrame, event.data)
    if (frame?.type === 'welcome') welcomed = true
    if (frame?.type === 'http.request') m.requests.push(frame)
    if (pong && frame?.type === 'ping') m.send({ type: 'pong', nonce: frame.nonce })
  })
  await new Promise((resolve) => ws.addEventListener('open', resolve))
  m.send({ type: 'hello', version: TUNNEL_PROTOCOL_VERSION, proof })
  machines.push(m)
  await until(() => welcomed)
  return m
}

async function until(check: () => boolean, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await Bun.sleep(5)
  }
}

function url(path: string, machineId = idA) {
  return `http://127.0.0.1:${server.port}${machinePathPrefix(machineId)}${path}`
}

describe('forward routes', () => {
  test('relay the request as sent and stream back the exact status, headers and body the machine answers', async () => {
    const logs = (['log', 'info', 'warn', 'error'] as const).map((method) => spyOn(console, method))
    try {
      const m = await machine(proofA)
      const body = new Uint8Array([0, 1, 2, 250, 255])
      const pending = fetch(url('/api/git/status?cwd=%2Ftmp'), {
        method: 'POST',
        headers: { [ACCESS_KEY_HEADER]: 'secret-key', 'x-thing': 'a', connection: 'keep-alive' },
        body,
      })
      await until(() => m.requests.length === 1)
      const request = m.requests[0]
      expect(request).toMatchObject({ type: 'http.request', id: 1, method: 'POST', path: '/api/git/status?cwd=%2Ftmp' })
      expect(request?.headers).toContainEqual([ACCESS_KEY_HEADER, 'secret-key'])
      expect(request?.headers).toContainEqual(['x-thing', 'a'])
      expect(request?.headers.some(([name]) => name === 'connection' || name === 'host')).toBe(false)
      expect([...(request?.body ?? [])]).toEqual([...body])

      m.send({
        type: 'http.response',
        id: 1,
        status: 418,
        headers: [
          ['x-teapot', 'yes'],
          ['set-cookie', 'a=1'],
          ['set-cookie', 'b=2'],
        ],
      })
      m.send({ type: 'http.body', id: 1, data: encoder.encode('hello ') })
      const response = await pending
      expect(response.status).toBe(418)
      expect(response.headers.get('x-teapot')).toBe('yes')
      expect(response.headers.getSetCookie()).toEqual(['a=1', 'b=2'])

      // The first chunk is readable before the machine ends the response.
      const reader = response.body?.getReader() as ReadableStreamDefaultReader<Uint8Array>
      expect(new TextDecoder().decode((await reader.read()).value)).toBe('hello ')
      m.send({ type: 'http.body', id: 1, data: encoder.encode('world') })
      m.send({ type: 'http.end', id: 1 })
      let rest = ''
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read())
        rest += new TextDecoder().decode(chunk.value)
      expect(rest).toBe('world')

      const unauthorised = fetch(url('/api/system/health'), { method: 'OPTIONS' })
      await until(() => m.requests.length === 2)
      expect(m.requests[1]).toMatchObject({ method: 'OPTIONS', path: '/api/system/health' })
      expect(m.requests[1]?.body).toBeUndefined()
      m.send({ type: 'http.response', id: 2, status: 401, headers: [] })
      m.send({ type: 'http.end', id: 2 })
      expect((await unauthorised).status).toBe(401)
      expect(forwarder.size).toBe(0)

      const logged = logs.flatMap((spy) => spy.mock.calls.map((call) => call.join(' ')))
      expect(logged.some((line) => line.includes('secret-key') || line.includes('git/status'))).toBe(false)
    } finally {
      for (const spy of logs) spy.mockRestore()
    }
  })

  test('give 502 with no machine data when the machine is offline or its tunnel closes before the head', async () => {
    const other = await machine(proofB)
    const offline = await fetch(url('/api/system/health'))
    expect(offline.status).toBe(502)
    expect(await offline.text()).toBe('Machine offline')
    expect(other.requests).toHaveLength(0)

    const dropped = await machine(proofA)
    const beforeHead = fetch(url('/api/a'))
    await until(() => dropped.requests.length === 1)
    dropped.ws.close()
    expect((await beforeHead).status).toBe(502)

    const replaced = await machine(proofA)
    const waiting = fetch(url('/api/b'))
    await until(() => replaced.requests.length === 1)
    await machine(proofA)
    expect((await waiting).status).toBe(502)
    expect(forwarder.size).toBe(0)
  })

  test('give 502 when a silent tunnel hits its heartbeat timeout before the head', async () => {
    const m = await machine(proofA, { pong: false })
    const pending = fetch(url('/api/a'))
    await until(() => m.requests.length === 1)
    expect((await pending).status).toBe(502)
    expect(forwarder.size).toBe(0)
  })

  test('answer 413 for a body that does not fit in one frame and 404 outside a machine API', async () => {
    const m = await machine(proofA)
    const tooBig = await fetch(url('/api/fs/upload'), { method: 'POST', body: new Uint8Array(MAX_TUNNEL_FRAME_BYTES) })
    expect(tooBig.status).toBe(413)
    expect((await fetch(url('/ws/terminal'))).status).toBe(404)
    expect((await fetch(url('/api'))).status).toBe(404)
    expect((await fetch(`http://127.0.0.1:${server.port}/api/system/health`)).status).toBe(404)
    expect(m.requests).toHaveLength(0)
  })
})
