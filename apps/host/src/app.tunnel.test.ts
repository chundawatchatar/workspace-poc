import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ACCESS_KEY_HEADER,
  type AppState,
  buildSocketUrl,
  CLOSE_ACCESS_DENIED,
  decodeFrame,
  encodeFrame,
  type MachineFrame,
  type RotateAccessResponse,
  remoteAccessStatus,
  routes,
  serverFrame,
  wsPayloadBytes,
} from '@orch/shared'
import {
  auth,
  clients,
  conns,
  dataOn,
  dir,
  hub,
  key,
  keys,
  local,
  OUTPUT,
  openLocal,
  secret,
  send,
  server,
  settingsFile,
  stub,
  tunnelApp,
  until,
  useTunnelHarness,
  welcomed,
} from './app.tunnel.testing'
import { tunnelEnv } from './lib/principal'
import { machineIdFromSecret } from './modules/access/access.service'
import { TunnelHttp } from './modules/tunnel/tunnel-http.service'

// The host's sockets end to end, on the harness in `app.tunnel.testing.ts`.
useTunnelHarness()

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

  test('the agent reporting channel is out of reach: tunneled and local requests touch no session', async () => {
    const conn = await welcomed()
    const headers: [string, string][] = [
      [ACCESS_KEY_HEADER, key],
      ['authorization', `Bearer ${'a'.repeat(64)}`],
      ['content-type', 'application/json'],
    ]
    const event = JSON.stringify({ agent: 'claude', state: 'working', reason: 'tool' })
    const body = new TextEncoder().encode(event)
    const request = (id: number, path: string) =>
      ({ type: 'http.request', id, method: 'POST', path, headers, body }) as const

    // A path outside `/api/` fails the tunnel's frame schema, so it never leaves the socket. Past that, the
    // request builder refuses it too, which is what a frame that got through would meet.
    expect(decodeFrame(serverFrame, encodeFrame(request(1, '/v1/state')))).toBeNull()
    const direct: MachineFrame[] = []
    const http = new TunnelHttp(
      async (incoming, principal) => tunnelApp.fetch(incoming, tunnelEnv(principal)),
      ({ key: presented }) => keys.authorize(presented),
      (frame) => direct.push(frame),
    )
    http.request(request(1, '/v1/state'))
    await until(() => direct.some((f) => f.type === 'http.end'))
    expect(direct[0]).toMatchObject({ type: 'http.response', status: 400 })

    const relayed = ['/api/v1/state', '/api/agent/state']
    relayed.forEach((path, index) => {
      send(conn, request(index + 2, path))
    })
    const response = (id: number) => conn.frames.find((f) => f.type === 'http.response' && f.id === id)
    await until(() => response(2) !== undefined && response(3) !== undefined)
    expect(response(2)).toMatchObject({ status: 404 })
    expect(response(3)).toMatchObject({ status: 404 })

    for (const path of ['/v1/state', ...relayed]) {
      const near = await fetch(`http://127.0.0.1:${local.port}${path}`, { method: 'POST', body: event })
      expect(near.status).toBe(404)
    }
    expect(stub.ensured).toEqual([])
    expect(stub.inputs).toEqual([])

    const sources = readdirSync(import.meta.dir, { recursive: true, encoding: 'utf8' }).filter(
      (file) => file.endsWith('.ts') && !file.endsWith('.test.ts'),
    )
    const reachesChannel = sources.filter((file) =>
      /agent\.sock|\/v1\/|Bearer/.test(readFileSync(join(import.meta.dir, file), 'utf8')),
    )
    expect(reachesChannel).toEqual([])
  })

  test('every remote access route answers 403 through the tunnel and leaves the setting and tunnel alone, but works locally', async () => {
    const conn = await welcomed()
    const saved = readFileSync(settingsFile, 'utf8')
    const { status, update } = routes.remoteAccess
    const endpoints = Object.values(routes.remoteAccess)
    for (const [index, endpoint] of endpoints.entries()) {
      send(conn, {
        type: 'http.request',
        id: index + 1,
        method: endpoint.method,
        path: endpoint.path,
        headers: [[ACCESS_KEY_HEADER, key]],
      })
    }
    const response = (id: number) => conn.frames.find((f) => f.type === 'http.response' && f.id === id)
    await until(() => endpoints.every((_, index) => response(index + 1) !== undefined))
    for (const [index] of endpoints.entries()) expect(response(index + 1)).toMatchObject({ status: 403 })
    expect(conn.frames.some((f) => f.type.startsWith('enroll.'))).toBe(false)
    expect(readFileSync(settingsFile, 'utf8')).toBe(saved)
    expect(clients).toHaveLength(1)
    expect(clients[0]?.status).toBe('connected')

    const near = await fetch(`http://127.0.0.1:${local.port}${status.path}`)
    const text = await near.text()
    expect(remoteAccessStatus.parse(JSON.parse(text))).toEqual({
      enabled: true,
      serverUrl: `ws://127.0.0.1:${server.port}`,
      serverUrlIsDefault: false,
      clientUrl: 'https://orch.example',
      serverUrlFromEnv: false,
      clientUrlFromEnv: false,
      machineId: machineIdFromSecret(secret),
      tunnel: 'connected',
      linkedAccount: null,
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
