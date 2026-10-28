import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from 'bun:test'
import { websocket } from '@hono/bun'
import {
  type AppState,
  buildSocketUrl,
  decodeFrame,
  encodeFrame,
  type HostInfo,
  type MachineFrame,
  machineFrame,
  routes,
  type ServerFrame,
  TUNNEL_PATH,
  wsPayloadBytes,
} from '@orch/shared'
import type { SessionManager, TermClient, TerminalSession } from '@orch/terminal'
import type { Server, ServerWebSocket } from 'bun'
import { type AppDeps, createApp } from './app'
import { EventHub } from './modules/events/events.service'
import type { LayoutRepository } from './modules/layout/layout.repository'
import { parseServerUrl, TunnelClient } from './modules/tunnel/tunnel.service'

// The host's sockets end to end: a real app and tunnel client, a fake server on
// one side, a stub session manager on the other, and the same app served locally
// to compare against.

const secret = `${'S'.repeat(42)}s`
const info: HostInfo = { home: '/home/me', shell: '/bin/zsh', platform: 'darwin', projectRoot: '/repo' }
const OUTPUT = new Uint8Array([27, 91, 72, 104, 105])

/** A session manager with one terminal, which records what reaches it. */
function stubSessions() {
  const attached = new Set<TermClient>()
  const ensured: unknown[][] = []
  const inputs: string[] = []
  const session = {
    info: () => ({ id: 't1', alive: true }),
    attach(client: TermClient) {
      attached.add(client)
      client.send(JSON.stringify({ type: 'snapshot' }))
      client.send(OUTPUT)
    },
    detach: (client: TermClient) => attached.delete(client),
    input: (data: string) => inputs.push(data),
    claim: () => {},
  } as unknown as TerminalSession
  const sessions = {
    ensure: (...args: unknown[]) => {
      ensured.push(args)
      return session
    },
    get: () => session,
    list: () => [session],
    collect: () => false,
  } as unknown as SessionManager
  return { sessions, attached, ensured, inputs }
}

/** A machine socket as the fake server sees it. */
interface Conn {
  ws: ServerWebSocket<unknown>
  frames: MachineFrame[]
}

let server: Server<unknown>
let local: Server<unknown>
let conns: Conn[]
let clients: TunnelClient[]
let stub: ReturnType<typeof stubSessions>
let hub: EventHub
let spies: Mock<(...args: unknown[]) => void>[]

beforeEach(() => {
  conns = []
  clients = []
  stub = stubSessions()
  hub = new EventHub()
  spies = (['log', 'warn'] as const).map((level) => spyOn(console, level).mockImplementation(() => {}))
  const state: AppState = { rev: 1, workspaces: [] }
  const layout = {
    state,
    set: (next: AppState) => {
      layout.state = next
    },
  } as LayoutRepository
  const { app, sockets } = createApp({ hub, layout, sessions: stub.sessions, info } as AppDeps)

  local = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch, websocket })
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, server) {
      if (new URL(request.url).pathname === TUNNEL_PATH && server.upgrade(request, { data: undefined })) return
      return new Response('not found', { status: 404 })
    },
    websocket: {
      open(ws) {
        conns.push({ ws, frames: [] })
      },
      message(ws, data) {
        const conn = conns.find((c) => c.ws === ws)
        const frame = decodeFrame(machineFrame, data)
        if (!conn || !frame) return
        conn.frames.push(frame)
        if (frame.type === 'hello') send(conn, { type: 'welcome', machineId: 'm' })
        // Like the server, it acks what it has delivered to the browser.
        if (frame.type === 'ws.data') {
          send(conn, { type: 'ws.ack', channel: frame.channel, bytes: wsPayloadBytes(frame.data) })
        }
      },
    },
  })

  const url = parseServerUrl(`ws://127.0.0.1:${server.port}`)
  if (!url) throw new Error('rejected the test server URL')
  const client = new TunnelClient({
    url,
    secret,
    handle: async (request) => app.fetch(request),
    openSocket: (path, headers, conn) => sockets.open(path, headers, conn),
    timings: { baseMs: 10, maxMs: 10 },
  })
  clients.push(client)
  client.start()
})

afterEach(async () => {
  for (const client of clients) client.stop()
  await server.stop(true)
  await local.stop(true)
  for (const spy of spies) spy.mockRestore()
})

function send(conn: Conn, frame: ServerFrame) {
  conn.ws.send(encodeFrame(frame))
}

async function until(check: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await Bun.sleep(2)
  }
}

/** The first connection, once it is welcomed. */
async function welcomed(): Promise<Conn> {
  await until(() => conns[0]?.frames.some((f) => f.type === 'hello') ?? false)
  const conn = conns[0]
  if (!conn) throw new Error('no connection')
  await Bun.sleep(5)
  return conn
}

/** The `ws.data` payloads sent on `channel`. */
const dataOn = (conn: Conn, channel: number) =>
  conn.frames.flatMap((f) => (f.type === 'ws.data' && f.channel === channel ? [f.data] : []))

/** Opens a local socket and collects its text messages. */
async function openLocal(path: string) {
  const messages: string[] = []
  const ws = new WebSocket(`ws://127.0.0.1:${local.port}${path}`)
  ws.addEventListener('message', (event) => typeof event.data === 'string' && messages.push(event.data))
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }))
  return { ws, messages }
}

describe('tunneled sockets', () => {
  test('the events socket says hello like a local one, ignores the auth message and broadcasts layout changes', async () => {
    const conn = await welcomed()
    const path = buildSocketUrl(routes.sockets.events, {})
    send(conn, { type: 'ws.open', channel: 1, path, headers: [] })
    send(conn, { type: 'ws.open', channel: 2, path, headers: [] })
    const near = await openLocal(path)
    await until(() => dataOn(conn, 1).length > 0 && near.messages.length > 0)

    const withoutId = (data: unknown) => ({ ...JSON.parse(String(data)), clientId: null })
    expect(withoutId(dataOn(conn, 1)[0])).toEqual(withoutId(near.messages[0]))

    const state: AppState = { rev: 2, workspaces: [] }
    const sent = [JSON.stringify({ type: 'auth', key: 'k' }), JSON.stringify({ type: 'state', state })]
    for (const data of sent) send(conn, { type: 'ws.data', channel: 1, data })
    await until(() => dataOn(conn, 2).length > 1 && near.messages.length > 1)
    expect(JSON.parse(String(dataOn(conn, 2)[1]))).toEqual({ type: 'state', state })
    expect(JSON.parse(near.messages[1] ?? '')).toEqual({ type: 'state', state })
    await until(() => conn.frames.some((f) => f.type === 'ws.ack' && f.channel === 1))
    const acked = conn.frames.reduce((sum, f) => sum + (f.type === 'ws.ack' && f.channel === 1 ? f.bytes : 0), 0)
    expect(acked).toBe(sent.reduce((sum, data) => sum + wsPayloadBytes(data), 0))
    near.ws.close()
  })

  test('the terminal socket attaches like the local route, takes input, and sends binary output as bytes', async () => {
    const conn = await welcomed()
    const path = buildSocketUrl(routes.sockets.terminal, { id: 't1', cwd: '/tmp/a b', cols: 100, rows: 30 })
    send(conn, { type: 'ws.open', channel: 1, path, headers: [['origin', 'http://localhost:3210']] })
    await until(() => dataOn(conn, 1).length >= 2)
    const near = await openLocal(path)
    const bad = await fetch(`http://127.0.0.1:${local.port}/ws/term/t1?cols=0`, { headers: { upgrade: 'websocket' } })

    expect(stub.ensured).toEqual([
      ['t1', '/tmp/a b', 100, 30],
      ['t1', '/tmp/a b', 100, 30],
    ])
    expect(bad.status).toBe(400)
    const [snapshot, output] = dataOn(conn, 1)
    expect(snapshot).toBe(JSON.stringify({ type: 'snapshot' }))
    expect(output).toBeInstanceOf(Uint8Array)
    expect([...(output as Uint8Array)]).toEqual([...OUTPUT])

    send(conn, { type: 'ws.data', channel: 1, data: JSON.stringify({ type: 'auth', key: 'k' }) })
    send(conn, { type: 'ws.data', channel: 1, data: JSON.stringify({ type: 'input', data: 'ls\n' }) })
    await until(() => stub.inputs.length > 0)
    expect(stub.inputs).toEqual(['ls\n'])
    near.ws.close()
  })

  test('a channel past the rate limit gets one ws.close 1008 and its terminal client is detached', async () => {
    const conn = await welcomed()
    send(conn, { type: 'ws.open', channel: 1, path: '/ws/term/t1', headers: [] })
    await until(() => stub.attached.size === 1)
    for (let i = 0; i < 1600; i++) send(conn, { type: 'ws.data', channel: 1, data: '{"type":"focus"}' })
    await until(() => conn.frames.some((f) => f.type === 'ws.close'))
    await Bun.sleep(20)
    expect(conn.frames.filter((f) => f.type === 'ws.close')).toEqual([
      { type: 'ws.close', channel: 1, code: 1008, reason: 'rate limit' },
    ])
    expect(stub.attached.size).toBe(0)
  })

  test('a dropped tunnel ends every channel, and nothing for them reaches the next connection', async () => {
    const conn = await welcomed()
    send(conn, { type: 'ws.open', channel: 1, path: '/ws/term/t1', headers: [] })
    send(conn, { type: 'ws.open', channel: 2, path: routes.sockets.events.path, headers: [] })
    await until(() => stub.attached.size === 1 && dataOn(conn, 2).length > 0)

    conn.ws.close(1000)
    await until(() => conns.length >= 2 && (conns[1]?.frames.some((f) => f.type === 'hello') ?? false))
    expect(stub.attached.size).toBe(0)
    hub.broadcast({ type: 'session.gone', id: 'x' })
    await Bun.sleep(20)
    expect(conns[1]?.frames.some((f) => f.type.startsWith('ws.'))).toBe(false)

    clients[0]?.stop()
    await Bun.sleep(30)
    expect(conns).toHaveLength(2)
  })
})
