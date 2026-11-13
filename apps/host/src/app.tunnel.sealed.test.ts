import { describe, expect, test } from 'bun:test'
import {
  auditLogResponse,
  buildSocketUrl,
  CLOSE_ACCESS_DENIED,
  E2E_REQUIRED_CODE,
  machineKeyResponse,
  routes,
} from '@orch/shared'
import {
  clients,
  dataOn,
  device,
  key,
  keyHeaders,
  local,
  machineId,
  machineKey,
  OUTPUT,
  openE2eSession,
  sealedRequest,
  sealedSocket,
  send,
  stub,
  until,
  useTunnelHarness,
  welcomed,
} from './app.tunnel.testing'
import { openMessages, sealedSocketEnvelope, sealMessage } from './modules/tunnel/tunnel.testing'

// Sockets sealed end to end, and unsealed traffic refused, on the harness in
// `app.tunnel.testing.ts`. The handshake and sealed requests are in
// `app.tunnel.test.ts`, which is full.
useTunnelHarness()

describe('unsealed tunnel traffic', () => {
  test('a plain request or socket is refused as unsealed, while the bootstrap, a sealed request and socket, and local access work', async () => {
    const conn = await welcomed()
    const health = routes.system.health.path
    const events = routes.sockets.events.path
    send(conn, {
      type: 'http.request',
      id: 1,
      method: 'GET',
      path: health,
      headers: await keyHeaders(key, 'GET', health),
    })
    send(conn, { type: 'ws.open', channel: 1, path: events, headers: [] })
    send(conn, { type: 'ws.data', channel: 1, data: JSON.stringify({ type: 'auth', key, device: 'p' }) })
    const of = (id: number) => conn.frames.filter((f) => 'id' in f && f.id === id)
    await until(() => of(1).some((f) => f.type === 'http.end') && conn.frames.some((f) => f.type === 'ws.close'))

    expect(of(1).find((f) => f.type === 'http.response')).toMatchObject({ status: 403 })
    const body = Buffer.concat(of(1).flatMap((f) => (f.type === 'http.body' ? [f.data] : []))).toString()
    expect(JSON.parse(body)).toMatchObject({ code: E2E_REQUIRED_CODE })
    expect(conn.frames.filter((f) => f.type === 'ws.close')).toEqual([
      { type: 'ws.close', channel: 1, code: CLOSE_ACCESS_DENIED, reason: 'end-to-end encryption required' },
    ])
    expect(conn.frames.some((f) => f.type === 'auth.failed')).toBe(false)

    const machineKeyPath = routes.system.machineKey.path
    send(conn, {
      type: 'http.request',
      id: 2,
      method: 'GET',
      path: machineKeyPath,
      headers: await keyHeaders(key, 'GET', machineKeyPath),
    })
    await until(() => of(2).some((f) => f.type === 'http.end'))
    const bootstrap = Buffer.concat(of(2).flatMap((f) => (f.type === 'http.body' ? [f.data] : []))).toString()
    expect(machineKeyResponse.parse(JSON.parse(bootstrap))).toEqual({ publicKey: machineKey.publicKey })
    const e2e = await openE2eSession(conn, 3)
    expect(await sealedRequest(conn, e2e, 4, 'GET', health)).toEqual({ status: 200, body: '{"ok":true}' })
    const socket = await sealedSocket(conn, e2e, 2, events)
    await until(() => dataOn(conn, 2).length > 0)
    expect(JSON.parse(String((await socket.messages())[0]))).toMatchObject({ type: 'hello' })

    const near = await fetch(`http://127.0.0.1:${local.port}${health}`)
    expect(near.status).toBe(200)
    const log = await fetch(`http://127.0.0.1:${local.port}${routes.remoteAccess.auditLog.path}`)
    const { entries } = auditLogResponse.parse(await log.json())
    const refused = entries.filter((entry) => entry.kind === 'refused')
    expect(refused.map(({ at: _, ...entry }) => entry)).toEqual([
      { kind: 'refused', reason: 'unsealed' },
      { kind: 'refused', reason: 'unsealed' },
    ])
  })
})

describe('tunneled sealed sockets', () => {
  test('a sealed events socket says hello and a sealed terminal socket takes input, as the session principal', async () => {
    const conn = await welcomed()
    const { session, sessionId } = await openE2eSession(conn, 1)
    const eventsPath = buildSocketUrl(routes.sockets.events, {})
    const events = await sealedSocketEnvelope(session, sessionId, 2, {
      path: eventsPath,
      auth: { type: 'auth', key, device: await device.socket(machineId, eventsPath) },
    })
    send(conn, { type: 'ws.sealed', channel: 1, data: events.data })
    const termPath = buildSocketUrl(routes.sockets.terminal, { id: 't1', cwd: '/tmp', cols: 80, rows: 24 })
    const term = await sealedSocketEnvelope(session, sessionId, 3, {
      path: termPath,
      auth: { type: 'auth', key, device: await device.socket(machineId, termPath) },
    })
    send(conn, { type: 'ws.sealed', channel: 2, data: term.data })
    await until(() => dataOn(conn, 1).length > 0 && dataOn(conn, 2).length >= 2)

    const [hello] = await openMessages(events.channel, dataOn(conn, 1))
    expect(JSON.parse(String(hello))).toMatchObject({ type: 'hello' })
    const [snapshot, output] = await openMessages(term.channel, dataOn(conn, 2).slice(0, 2))
    expect([snapshot, output]).toEqual([JSON.stringify({ type: 'snapshot' }), OUTPUT])
    expect(stub.ensured).toEqual([['t1', '/tmp', 80, 24]])
    send(conn, {
      type: 'ws.data',
      channel: 2,
      data: await sealMessage(term.channel, '{"type":"input","data":"ls\\n"}'),
    })
    await until(() => stub.inputs.length > 0)
    expect(stub.inputs).toEqual(['ls\n'])
    expect(clients[0]?.listChannels().map((c) => c.principal)).toEqual([
      expect.objectContaining({ kind: 'key', deviceId: device.id }),
      expect.objectContaining({ kind: 'key', deviceId: device.id }),
    ])
    const sent = [...dataOn(conn, 1), ...dataOn(conn, 2)]
    expect(sent.every((data) => data instanceof Uint8Array)).toBe(true)
    const clear = Buffer.concat(sent as Uint8Array[]).toString('latin1')
    expect(['"hello"', 'snapshot'].some((text) => clear.includes(text))).toBe(false)
  })
})
