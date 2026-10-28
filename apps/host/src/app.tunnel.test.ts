import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { websocket } from '@hono/bun'
import {
  ACCESS_KEY_HEADER,
  type AppState,
  buildSocketUrl,
  CLOSE_ACCESS_DENIED,
  decodeFrame,
  encodeFrame,
  type HostInfo,
  type MachineFrame,
  machineFrame,
  type RotateAccessResponse,
  remoteAccessStatus,
  routes,
  type ServerFrame,
  TUNNEL_PATH,
  wsPayloadBytes,
} from '@orch/shared'
import type { SessionManager, TermClient, TerminalSession } from '@orch/terminal'
import type { Server, ServerWebSocket } from 'bun'
import { type AppDeps, createApp } from './app'
import { tunnelEnv } from './lib/principal'
import { AccessKeyRepository } from './modules/access/access.repository'
import { AccessKeys, machineIdFromSecret } from './modules/access/access.service'
import { EventHub } from './modules/events/events.service'
import type { LayoutRepository } from './modules/layout/layout.repository'
import { RemoteAccessRepository } from './modules/remote-access/remote-access.repository'
import { RemoteAccessService } from './modules/remote-access/remote-access.service'
import { TunnelClient } from './modules/tunnel/tunnel.service'

// The host's sockets end to end: a real app, remote access service and tunnel
// client, wired as `index.ts` wires them and turned on by a saved setting, a fake
// server on one side, a stub session manager on the other, and the same app
// served locally to compare against.

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
let dir: string
let keys: AccessKeys
let key: string
let remoteAccess: RemoteAccessService
let settingsFile: string

beforeEach(() => {
  conns = []
  clients = []
  dir = mkdtempSync(join(tmpdir(), 'orch-access-'))
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
        if (frame.type === 'hello') send(conn, { type: 'welcome', machineId: machineIdFromSecret(secret) })
        // Like the server, it acks what it has delivered to the browser.
        if (frame.type === 'ws.data') {
          send(conn, { type: 'ws.ack', channel: frame.channel, bytes: wsPayloadBytes(frame.data) })
        }
      },
    },
  })

  const secretFile = join(dir, 'machine-secret')
  const keysFile = join(dir, 'access-keys.json')
  settingsFile = join(dir, 'remote-access.json')
  writeFileSync(secretFile, secret)
  key = new AccessKeys(new AccessKeyRepository(keysFile)).create('default')
  writeFileSync(
    settingsFile,
    JSON.stringify({ enabled: true, serverUrl: `ws://127.0.0.1:${server.port}`, clientUrl: 'https://orch.example' }),
  )
  remoteAccess = new RemoteAccessService({
    repository: new RemoteAccessRepository(settingsFile),
    secretFile,
    keysFile,
    handle: async (request, principal) => app.fetch(request, tunnelEnv(principal)),
    openSocket: (path, headers, conn, principal) => sockets.open(path, headers, conn, principal),
    createTunnel: (options) => {
      const client = new TunnelClient({ ...options, timings: { baseMs: 10, maxMs: 10, authTimeoutMs: 100 } })
      clients.push(client)
      return client
    },
  })
  const { app, sockets } = createApp({
    hub,
    layout,
    sessions: stub.sessions,
    info,
    access: () => remoteAccess.current(),
    remoteAccess,
  } as unknown as AppDeps)
  local = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch, websocket })

  remoteAccess.start()
  const current = remoteAccess.current()
  if (!current) throw new Error('remote access did not start')
  keys = current.keys
})

afterEach(async () => {
  remoteAccess.shutdown()
  for (const client of clients) client.stop()
  await server.stop(true)
  await local.stop(true)
  for (const spy of spies) spy.mockRestore()
  rmSync(dir, { recursive: true, force: true })
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

/** The auth message for `presented`. */
const auth = (presented: string) => JSON.stringify({ type: 'auth', key: presented })

/** Opens a local socket and collects its text messages. */
async function openLocal(path: string) {
  const messages: string[] = []
  const ws = new WebSocket(`ws://127.0.0.1:${local.port}${path}`)
  ws.addEventListener('message', (event) => typeof event.data === 'string' && messages.push(event.data))
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }))
  return { ws, messages }
}

describe('tunneled sockets', () => {
  test('the events socket says hello like a local one after a valid key, even from a foreign origin, and broadcasts layout changes', async () => {
    const conn = await welcomed()
    const path = buildSocketUrl(routes.sockets.events, {})
    for (const channel of [1, 2]) {
      send(conn, { type: 'ws.open', channel, path, headers: [['origin', 'https://orch.example']] })
      send(conn, { type: 'ws.data', channel, data: auth(key) })
    }
    const near = await openLocal(path)
    await until(() => dataOn(conn, 1).length > 0 && near.messages.length > 0)

    const withoutId = (data: unknown) => ({ ...JSON.parse(String(data)), clientId: null })
    expect(withoutId(dataOn(conn, 1)[0])).toEqual(withoutId(near.messages[0]))

    const state: AppState = { rev: 2, workspaces: [] }
    const sent = [auth(key), JSON.stringify({ type: 'state', state })]
    send(conn, { type: 'ws.data', channel: 1, data: sent[1] ?? '' })
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
    send(conn, { type: 'ws.data', channel: 1, data: auth(key) })
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

    send(conn, { type: 'ws.data', channel: 1, data: JSON.stringify({ type: 'input', data: 'ls\n' }) })
    await until(() => stub.inputs.length > 0)
    expect(stub.inputs).toEqual(['ls\n'])
    near.ws.close()
  })

  test('a channel past the rate limit gets one ws.close 1008 and its terminal client is detached', async () => {
    const conn = await welcomed()
    send(conn, { type: 'ws.open', channel: 1, path: '/ws/term/t1', headers: [] })
    send(conn, { type: 'ws.data', channel: 1, data: auth(key) })
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
    for (const channel of [1, 2]) send(conn, { type: 'ws.data', channel, data: auth(key) })
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

  test('a wrong key, a late key or binary first data gets auth.failed then 4401, and no handler runs', async () => {
    const conn = await welcomed()
    const path = '/ws/term/t1'
    for (const channel of [1, 2, 3]) send(conn, { type: 'ws.open', channel, path, headers: [] })
    send(conn, { type: 'ws.data', channel: 1, data: auth('x'.repeat(43)) })
    send(conn, { type: 'ws.data', channel: 2, data: new TextEncoder().encode(auth(key)) })
    await Bun.sleep(150)
    send(conn, { type: 'ws.data', channel: 3, data: auth(key) })
    await until(() => conn.frames.filter((f) => f.type === 'ws.close').length === 3)
    await Bun.sleep(20)

    expect(stub.ensured).toEqual([])
    for (const channel of [1, 2, 3]) {
      const frames = conn.frames.filter((f) => 'channel' in f && f.channel === channel)
      expect(frames.map((f) => f.type)).toEqual(['auth.failed', 'ws.close'])
      expect(frames[1]).toMatchObject({ code: CLOSE_ACCESS_DENIED })
    }
  })

  test('a local rotate closes the old key channels and refuses its requests, the new key works, and a tunneled rotate gets 403', async () => {
    const conn = await welcomed()
    send(conn, { type: 'ws.open', channel: 1, path: '/ws/term/t1', headers: [] })
    send(conn, { type: 'ws.data', channel: 1, data: auth(key) })
    await until(() => stub.attached.size === 1)

    const rotatePath = routes.access.rotate.path
    const tunneled = (id: number, presented: string, path: string, method = 'GET') =>
      send(conn, { type: 'http.request', id, method, path, headers: [[ACCESS_KEY_HEADER, presented]] })
    const status = (id: number) => conn.frames.find((f) => f.type === 'http.response' && f.id === id)
    tunneled(1, key, rotatePath, 'POST')
    await until(() => status(1) !== undefined)
    expect(status(1)).toMatchObject({ status: 403 })
    expect(keys.authorize(key)).not.toBeNull()

    const response = await fetch(`http://127.0.0.1:${local.port}${rotatePath}`, { method: 'POST' })
    const rotated = (await response.json()) as RotateAccessResponse
    const machineId = machineIdFromSecret(secret)
    expect(rotated.machineId).toBe(machineId)
    expect(rotated.link).toBe(`https://orch.example/#machine=${machineId}&key=${rotated.key}`)
    await until(() => conn.frames.some((f) => f.type === 'ws.close'))
    expect(conn.frames.filter((f) => f.type === 'ws.close')).toEqual([
      { type: 'ws.close', channel: 1, code: CLOSE_ACCESS_DENIED, reason: 'key rotated' },
    ])
    expect(stub.attached.size).toBe(0)

    tunneled(2, key, routes.system.health.path)
    tunneled(3, rotated.key, routes.system.health.path)
    send(conn, { type: 'ws.open', channel: 2, path: '/ws/term/t1', headers: [] })
    send(conn, { type: 'ws.data', channel: 2, data: auth(key) })
    await until(() => status(2) !== undefined && status(3) !== undefined)
    await until(() => conn.frames.some((f) => f.type === 'auth.failed' && f.channel === 2))
    expect(status(2)).toMatchObject({ status: 401 })
    expect(status(3)).toMatchObject({ status: 200 })
    expect(stub.ensured).toHaveLength(1)
  })

  test('the remote access routes answer 403 through the tunnel and leave the setting and tunnel alone, but work locally', async () => {
    const conn = await welcomed()
    const saved = readFileSync(settingsFile, 'utf8')
    const { status, update } = routes.remoteAccess
    send(conn, {
      type: 'http.request',
      id: 1,
      method: status.method,
      path: status.path,
      headers: [[ACCESS_KEY_HEADER, key]],
    })
    send(conn, {
      type: 'http.request',
      id: 2,
      method: update.method,
      path: update.path,
      headers: [[ACCESS_KEY_HEADER, key]],
    })
    const response = (id: number) => conn.frames.find((f) => f.type === 'http.response' && f.id === id)
    await until(() => response(1) !== undefined && response(2) !== undefined)
    expect(response(1)).toMatchObject({ status: 403 })
    expect(response(2)).toMatchObject({ status: 403 })
    expect(readFileSync(settingsFile, 'utf8')).toBe(saved)
    expect(clients).toHaveLength(1)
    expect(clients[0]?.status).toBe('connected')

    const near = await fetch(`http://127.0.0.1:${local.port}${status.path}`)
    const text = await near.text()
    expect(remoteAccessStatus.parse(JSON.parse(text))).toEqual({
      enabled: true,
      serverUrl: `ws://127.0.0.1:${server.port}`,
      clientUrl: 'https://orch.example',
      serverUrlFromEnv: false,
      clientUrlFromEnv: false,
      machineId: machineIdFromSecret(secret),
      tunnel: 'connected',
    })
    for (const hidden of [
      secret,
      key,
      readFileSync(join(dir, 'access-keys.json'), 'utf8').match(/"hash": "([^"]+)"/)?.[1],
    ]) {
      expect(text).not.toContain(hidden ?? 'missing')
    }

    const off = await fetch(`http://127.0.0.1:${local.port}${update.path}`, {
      method: update.method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false, serverUrl: `ws://127.0.0.1:${server.port}`, clientUrl: null }),
    })
    expect(remoteAccessStatus.parse(await off.json())).toMatchObject({ enabled: false, tunnel: 'off', clientUrl: null })
    expect(clients[0]?.status).toBe('off')
    expect(JSON.parse(readFileSync(settingsFile, 'utf8'))).toMatchObject({ enabled: false })
  })
})
