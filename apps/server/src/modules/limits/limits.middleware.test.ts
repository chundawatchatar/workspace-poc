import { afterEach, describe, expect, test } from 'bun:test'
import {
  CLOSE_RATE_LIMITED,
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
import { ChannelBridge } from '../bridge/bridge.service'
import { HttpForwarder } from '../forward/forward.service'
import { MachineRegistry, machineIdFromProof } from '../tunnel/tunnel.service'
import { ConnectionLimiter, type ConnectionLimiterDeps } from './limits.service'

const proof = `${'A'.repeat(42)}a`
const machineId = machineIdFromProof(proof)

let server: Server<unknown> | undefined
const sockets: WebSocket[] = []

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close()
  await server?.stop(true)
})

/**
 * A server behind a trusted proxy, so each test picks its client IP with
 * `X-Forwarded-For`, and a fake machine that records the frames it is sent.
 */
async function setup(limits: ConnectionLimiterDeps) {
  const registry = new MachineRegistry()
  const app = createApp({
    registry,
    forwarder: new HttpForwarder({ registry }),
    bridge: new ChannelBridge({ registry }),
    limiter: new ConnectionLimiter(limits),
    trustProxy: true,
  })
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch, websocket: serverWebSocket })
  const base = `127.0.0.1:${server.port}`

  const ws = new WebSocket(`ws://${base}${TUNNEL_PATH}`, { headers: { 'x-forwarded-for': 'machine' } })
  sockets.push(ws)
  const frames: ServerFrame[] = []
  ws.addEventListener('message', (event) => {
    const frame = decodeFrame(serverFrame, event.data)
    if (frame) frames.push(frame)
  })
  await new Promise((resolve) => ws.addEventListener('open', resolve))
  const send = (frame: MachineFrame) => ws.send(encodeFrame(frame))
  send({ type: 'hello', version: TUNNEL_PROTOCOL_VERSION, proof })
  await until(() => frames.some((f) => f.type === 'welcome'))

  const request = (ip: string) =>
    fetch(`http://${base}${machinePathPrefix(machineId)}/api/health`, { headers: { 'x-forwarded-for': ip } })
  // A request the machine never answers. It fails once the server stops, which the test does not care about.
  const unanswered = (ip: string) => void request(ip).catch(() => {})
  const socket = (ip: string) => {
    const browser = new WebSocket(`ws://${base}${machinePathPrefix(machineId)}/ws/events`, {
      headers: { 'x-forwarded-for': ip },
    })
    sockets.push(browser)
    return new Promise<number>((resolve) => browser.addEventListener('close', (e) => resolve(e.code)))
  }
  const of = <T extends ServerFrame['type']>(type: T) =>
    frames.filter((f): f is Extract<ServerFrame, { type: T }> => f.type === type)
  return { base, send, request, unanswered, socket, of }
}

async function until(check: () => boolean, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await Bun.sleep(5)
  }
}

describe('connection limits', () => {
  test('an IP past its bucket gets 429 with Retry-After, and its sockets close with 4429 before any ws.open', async () => {
    const { request, unanswered, socket, of } = await setup({ perIp: { capacity: 1, refillEveryMs: 5000 } })
    unanswered('1.1.1.1')
    await until(() => of('http.request').length === 1)
    const refused = await request('1.1.1.1')
    expect(refused.status).toBe(429)
    expect(refused.headers.get('retry-after')).toBe('5')
    expect(await socket('1.1.1.1')).toBe(CLOSE_RATE_LIMITED)
    await Bun.sleep(20)
    expect(of('http.request')).toHaveLength(1)
    expect(of('ws.open')).toHaveLength(0)
  })

  test('tunnel upgrades past the per-IP bucket get 429', async () => {
    const { base } = await setup({ tunnelPerIp: { capacity: 1, refillEveryMs: 10_000 } })
    // The check runs before the upgrade, so a plain request shows its status.
    const again = await fetch(`http://${base}${TUNNEL_PATH}`, { headers: { 'x-forwarded-for': 'machine' } })
    expect(again.status).toBe(429)
    expect(again.headers.get('retry-after')).toBe('10')
  })

  test('ten auth.failed frames for one IP block its 11th request and sockets, and no other IP', async () => {
    const { send, request, unanswered, socket, of } = await setup({})
    // Five rejected requests and five rejected sockets from the same browser.
    for (let i = 0; i < 5; i++) unanswered('6.6.6.6')
    for (let i = 0; i < 5; i++) void socket('6.6.6.6')
    await until(() => of('http.request').length === 5 && of('ws.open').length === 5)
    const [last, ...rest] = of('http.request')
    for (const { id } of rest) send({ type: 'auth.failed', id })
    for (const { channel } of of('ws.open')) send({ type: 'auth.failed', channel })
    // A repeated report for the same request or channel counts once, so nine reports are not yet a block.
    for (const { id } of rest) send({ type: 'auth.failed', id })
    for (const { channel } of of('ws.open')) send({ type: 'auth.failed', channel })
    await Bun.sleep(30)
    unanswered('6.6.6.6')
    await until(() => of('http.request').length === 6)
    if (last) send({ type: 'auth.failed', id: last.id })
    // Unknown ids and channels count for nobody.
    send({ type: 'auth.failed', id: 999 })
    send({ type: 'auth.failed', channel: 999 })
    await Bun.sleep(30)

    const blocked = await request('6.6.6.6')
    expect(blocked.status).toBe(429)
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(await socket('6.6.6.6')).toBe(CLOSE_RATE_LIMITED)
    unanswered('7.7.7.7')
    await until(() => of('http.request').length === 7)
    expect(of('ws.open')).toHaveLength(5)
  })
})
