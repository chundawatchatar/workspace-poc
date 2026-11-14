import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ACCESS_KEY_HEADER,
  type AppState,
  buildSocketUrl,
  CLOSE_ACCESS_DENIED,
  DEVICE_NOT_APPROVED_CODE,
  DEVICE_PROOF_HEADER,
  decodeFrame,
  encodeFrame,
  machineFingerprint,
  machineIdFromPublicKey,
  machineKeyResponse,
  openE2eSessionResponse,
  type RotateAccessResponse,
  remoteAccessStatus,
  routes,
  serverFrame,
  startBrowserHandshake,
} from '@orch/shared'
import {
  clients,
  conns,
  dataOn,
  device,
  dir,
  e2eSessions,
  hub,
  key,
  keyHeaders,
  keys,
  local,
  machineId,
  machineKey,
  openE2eSession,
  openLocal,
  remoteAccess,
  sealedRequest,
  sealedSocket,
  send,
  server,
  settingsFile,
  stub,
  until,
  useTunnelHarness,
  welcomed,
} from './app.tunnel.testing'
import { testDevice } from './modules/remote-access/device-proof.testing'
import { helloVerifies, openSealedReply, sealedEnvelope } from './modules/tunnel/tunnel.testing'
import { tunneledRequest } from './modules/tunnel/tunnel-http.service'

// The host's sockets end to end, on the harness in `app.tunnel.testing.ts`.
useTunnelHarness()

describe('tunneled sockets', () => {
  test('a sealed events socket says hello like a local one and broadcasts layout changes', async () => {
    const conn = await welcomed()
    const e2e = await openE2eSession(conn, 1)
    const path = buildSocketUrl(routes.sockets.events, {})
    const first = await sealedSocket(conn, e2e, 1, path)
    const second = await sealedSocket(conn, e2e, 2, path)
    const near = await openLocal(path)
    await until(() => dataOn(conn, 1).length > 0 && dataOn(conn, 2).length > 0 && near.messages.length > 0)

    const withoutId = (data: unknown) => ({ ...JSON.parse(String(data)), clientId: null })
    expect(withoutId((await first.messages())[0])).toEqual(withoutId(near.messages[0]))

    const state: AppState = { rev: 2, workspaces: [] }
    const sent = await first.send(JSON.stringify({ type: 'state', state }))
    await until(() => dataOn(conn, 2).length > 1 && near.messages.length > 1)
    expect(JSON.parse(String((await second.messages())[1]))).toEqual({ type: 'state', state })
    expect(JSON.parse(near.messages[1] ?? '')).toEqual({ type: 'state', state })
    await until(() => conn.frames.some((f) => f.type === 'ws.ack' && f.channel === 1))
    const acked = conn.frames.reduce((sum, f) => sum + (f.type === 'ws.ack' && f.channel === 1 ? f.bytes : 0), 0)
    // The auth came sealed in the open, so only the message is acked, by its sealed size.
    expect(acked).toBe(sent)
    near.ws.close()
  })

  test('a channel past the rate limit gets one ws.close 1008 and its terminal client is detached', async () => {
    const conn = await welcomed()
    const term = await sealedSocket(conn, await openE2eSession(conn, 1), 1, '/ws/term/t1')
    await until(() => stub.attached.size === 1)
    for (let i = 0; i < 1600; i++) await term.send('{"type":"focus"}')
    await until(() => conn.frames.some((f) => f.type === 'ws.close'))
    await Bun.sleep(20)
    expect(conn.frames.filter((f) => f.type === 'ws.close')).toEqual([
      { type: 'ws.close', channel: 1, code: 1008, reason: 'rate limit' },
    ])
    expect(stub.attached.size).toBe(0)
  })

  test('a dropped tunnel ends every channel, and nothing for them reaches the next connection', async () => {
    const conn = await welcomed()
    const e2e = await openE2eSession(conn, 1)
    await sealedSocket(conn, e2e, 1, '/ws/term/t1')
    await sealedSocket(conn, e2e, 2, routes.sockets.events.path)
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

  test('a local rotate closes the old key channels and refuses its requests, the new key works, and a tunneled rotate gets 403', async () => {
    const conn = await welcomed()
    const e2e = await openE2eSession(conn, 1)
    await sealedSocket(conn, e2e, 1, '/ws/term/t1')
    await until(() => stub.attached.size === 1)

    const rotatePath = routes.access.rotate.path
    expect((await sealedRequest(conn, e2e, 2, 'POST', rotatePath)).status).toBe(403)
    expect(keys.authorize(key)).not.toBeNull()

    const response = await fetch(`http://127.0.0.1:${local.port}${rotatePath}`, { method: 'POST' })
    const rotated = (await response.json()) as RotateAccessResponse
    expect(rotated.machineId).toBe(machineId)
    expect(rotated.link).toBe(
      `https://orch.example/#machine=${machineId}&key=${rotated.key}&fp=${machineFingerprint(machineId)}`,
    )
    await until(() => conn.frames.some((f) => f.type === 'ws.close'))
    expect(conn.frames.filter((f) => f.type === 'ws.close')).toEqual([
      { type: 'ws.close', channel: 1, code: CLOSE_ACCESS_DENIED, reason: 'key rotated' },
    ])
    expect(stub.attached.size).toBe(0)

    // The old key's session closed with it, and the old key opens no new one.
    expect((await sealedRequest(conn, e2e, 3, 'GET', routes.system.health.path)).status).toBe(409)
    const { method, path } = routes.e2e.open
    send(conn, { type: 'http.request', id: 4, method, path, headers: await keyHeaders(key, method, path) })
    const renewed = await openE2eSession(conn, 5, { key: rotated.key })
    const health = await sealedRequest(conn, renewed, 6, 'GET', routes.system.health.path, { as: { key: rotated.key } })
    expect(health.status).toBe(200)
    // The old key on the new key's session.
    await sealedSocket(conn, renewed, 2, '/ws/term/t1')
    await until(() => conn.frames.some((f) => f.type === 'http.response' && f.id === 4))
    await until(() => conn.frames.some((f) => f.type === 'auth.failed' && f.channel === 2))
    expect(conn.frames.find((f) => f.type === 'http.response' && f.id === 4)).toMatchObject({ status: 401 })
    expect(stub.ensured).toHaveLength(1)
  })

  test('the agent reporting channel is out of reach: tunneled and local requests touch no session', async () => {
    const conn = await welcomed()
    const event = JSON.stringify({ agent: 'claude', state: 'working', reason: 'tool' })
    const body = new TextEncoder().encode(event)
    const request = async (id: number, path: string) => {
      const headers: [string, string][] = [
        ...(await keyHeaders(key, 'POST', path, event)),
        ['authorization', `Bearer ${'a'.repeat(64)}`],
        ['content-type', 'application/json'],
      ]
      return { type: 'http.request', id, method: 'POST', path, headers, body } as const
    }

    // A path outside `/api/` fails the tunnel's frame schema, so it never leaves the socket. Past that, it is
    // refused as unsealed, and the request builder refuses it too, which is what a sealed one would meet.
    expect(decodeFrame(serverFrame, encodeFrame(await request(1, '/v1/state')))).toBeNull()
    expect(tunneledRequest(await request(1, '/v1/state'))).toBeNull()

    const relayed = ['/api/v1/state', '/api/agent/state']
    const e2e = await openE2eSession(conn, 2)
    for (const [index, path] of relayed.entries()) {
      const headers: [string, string][] = [['authorization', `Bearer ${'a'.repeat(64)}`]]
      const reply = await sealedRequest(conn, e2e, index + 3, 'POST', path, { body: event, headers })
      expect([path, reply.status]).toEqual([path, 404])
    }

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

  test('the host answers the challenge with its public key only, under the id the server, status and link all use', async () => {
    const conn = await welcomed()
    await until(() => clients[0]?.status === 'connected')
    const hello = conn.frames.find((f) => f.type === 'hello')
    if (hello?.type !== 'hello') throw new Error('no hello')
    expect(hello.publicKey).toBe(machineKey.publicKey)
    expect(helloVerifies(hello, conn.nonce)).toBe(true)
    expect(await machineIdFromPublicKey(hello.publicKey)).toBe(machineId)

    const status = await fetch(`http://127.0.0.1:${local.port}${routes.remoteAccess.status.path}`)
    expect(remoteAccessStatus.parse(await status.json())).toMatchObject({
      machineId,
      machineFingerprint: machineFingerprint(machineId),
    })
    expect(remoteAccess.current()?.machineId).toBe(machineId)

    // Neither the raw private key nor any line of the key file went over the tunnel.
    const sent = conn.raw.join('\n')
    expect(sent).not.toContain(machineKey.privateKey)
    for (const line of machineKey.pem.split('\n').filter((l) => l && !l.startsWith('-----'))) {
      expect(sent).not.toContain(line)
    }
  })

  test('the machine key route answers the public key locally and to an approved device, never the private key', async () => {
    const conn = await welcomed()
    const path = routes.system.machineKey.path
    const near = await fetch(`http://127.0.0.1:${local.port}${path}`)
    expect(machineKeyResponse.parse(await near.json())).toEqual({ publicKey: machineKey.publicKey })

    const stranger = await testDevice()
    const strangerProof = await stranger.proof({ machineId, method: 'GET', path })
    const requests: [number, [string, string][]][] = [
      [1, await keyHeaders(key, 'GET', path)],
      [
        2,
        [
          [ACCESS_KEY_HEADER, key],
          [DEVICE_PROOF_HEADER, strangerProof],
        ],
      ],
      [3, []],
    ]
    for (const [id, headers] of requests) send(conn, { type: 'http.request', id, method: 'GET', path, headers })
    const response = (id: number) => conn.frames.find((f) => f.type === 'http.response' && f.id === id)
    const body = (id: number) =>
      Buffer.concat(conn.frames.flatMap((f) => (f.type === 'http.body' && f.id === id ? [f.data] : []))).toString()
    await until(() => [1, 2, 3].every((id) => conn.frames.some((f) => f.type === 'http.end' && f.id === id)))

    expect([1, 2, 3].map((id) => response(id))).toMatchObject([{ status: 200 }, { status: 403 }, { status: 401 }])
    expect(machineKeyResponse.parse(JSON.parse(body(1)))).toEqual({ publicKey: machineKey.publicKey })
    expect(JSON.parse(body(2))).toMatchObject({ code: DEVICE_NOT_APPROVED_CODE })
    expect(body(1)).not.toContain(machineKey.privateKey)
  })

  test('every remote access route answers 403 through the tunnel and leaves the setting and tunnel alone, but works locally', async () => {
    const conn = await welcomed()
    const saved = readFileSync(settingsFile, 'utf8')
    const { status, update } = routes.remoteAccess
    const e2e = await openE2eSession(conn, 1)
    for (const [index, endpoint] of Object.values(routes.remoteAccess).entries()) {
      const reply = await sealedRequest(conn, e2e, index + 2, endpoint.method, endpoint.path)
      expect([endpoint.path, reply.status]).toEqual([endpoint.path, 403])
    }
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
      serverUrlSetBy: null,
      clientUrlSetBy: null,
      savedServerUrl: `ws://127.0.0.1:${server.port}`,
      savedClientUrl: 'https://orch.example',
      restartNeeded: false,
      machineId,
      machineFingerprint: machineFingerprint(machineId),
      tunnel: 'connected',
      linkedAccount: null,
    })
    for (const hidden of [
      machineKey.privateKey,
      machineKey.pem,
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
    // The cleared client address is saved for the next start; the one in use stays until then.
    expect(remoteAccessStatus.parse(await off.json())).toMatchObject({
      enabled: false,
      tunnel: 'off',
      clientUrl: 'https://orch.example',
      savedClientUrl: null,
      restartNeeded: true,
    })
    expect(clients[0]?.status).toBe('off')
    expect(JSON.parse(readFileSync(settingsFile, 'utf8'))).toMatchObject({ enabled: false })
  })
})

describe('tunneled end-to-end handshake', () => {
  test('an approved device opens a session the host keeps, and every other caller or hello opens none', async () => {
    const conn = await welcomed()
    const { path, method } = routes.e2e.open
    const stranger = await testDevice()
    const encoder = new TextEncoder()
    const browser = await startBrowserHandshake({ machineId, device: device.signer })
    const theirs = await startBrowserHandshake({ machineId, device: stranger.signer })
    const forged = {
      ...browser.hello,
      signature: browser.hello.signature.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')),
    }
    const ask = async (id: number, body: string, headers?: [string, string][]) =>
      send(conn, {
        type: 'http.request',
        id,
        method,
        path,
        headers: [['content-type', 'application/json'], ...(headers ?? (await keyHeaders(key, method, path, body)))],
        body: encoder.encode(body),
      })
    const strangerHeaders = async (body: string): Promise<[string, string][]> => [
      [ACCESS_KEY_HEADER, key],
      [DEVICE_PROOF_HEADER, await stranger.proof({ machineId, method, path, body })],
    ]
    const json = (value: unknown) => JSON.stringify(value)
    await ask(1, json(browser.hello))
    await ask(2, json(theirs.hello), await strangerHeaders(json(theirs.hello)))
    await ask(3, json(browser.hello), [])
    // Signed by the stranger's key but sent with the approved device's proof.
    await ask(4, json(theirs.hello))
    await ask(5, json({ ...browser.hello, v: 'one' }))
    await ask(6, json(forged))
    const ids = [1, 2, 3, 4, 5, 6]
    const response = (id: number) => conn.frames.find((f) => f.type === 'http.response' && f.id === id)
    const body = (id: number) =>
      Buffer.concat(conn.frames.flatMap((f) => (f.type === 'http.body' && f.id === id ? [f.data] : []))).toString()
    await until(() => ids.every((id) => conn.frames.some((f) => f.type === 'http.end' && f.id === id)))

    expect(ids.map(response)).toMatchObject([
      { status: 200 },
      { status: 403 },
      { status: 401 },
      { status: 403 },
      { status: 400 },
      { status: 400 },
    ])
    expect(JSON.parse(body(2))).toMatchObject({ code: DEVICE_NOT_APPROVED_CODE })
    const opened = openE2eSessionResponse.parse(JSON.parse(body(1)))
    const session = await browser.finish(opened.hello, machineKey.publicKey)
    const kept = e2eSessions.get(opened.sessionId)
    expect(kept?.principal).toMatchObject({ kind: 'key', deviceId: device.id })
    const sealed = await session.seal(encoder.encode('ls'))
    expect(new TextDecoder().decode(await kept?.session.open(sealed))).toBe('ls')
    expect(await kept?.session.seal(encoder.encode('ok')).then((reply) => session.open(reply))).toEqual(
      encoder.encode('ok'),
    )

    // Locally there is no device to bind a session to.
    const near = await fetch(`http://127.0.0.1:${local.port}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: json((await startBrowserHandshake({ machineId, device: device.signer })).hello),
    })
    expect(near.status).toBe(403)
  })

  test('a sealed request on a live session is served like a plain one, and a replay or a closed session is refused', async () => {
    const conn = await welcomed()
    const { session, sessionId } = await openE2eSession(conn, 1)
    const of = (id: number) => conn.frames.filter((f) => 'id' in f && f.id === id)
    const ended = (id: number) => until(() => of(id).some((f) => f.type === 'http.end'))
    const payloads = (id: number) => of(id).flatMap((f) => (f.type === 'http.body' ? [f.data] : []))

    const health = routes.system.health.path
    const request = { method: 'GET', path: health, headers: await keyHeaders(key, 'GET', health) }
    const { channel, data } = await sealedEnvelope(session, sessionId, 1, request)
    send(conn, { type: 'http.sealed', id: 2, data })
    await ended(2)
    const reply = await openSealedReply(channel, payloads(2))
    const direct = await fetch(`http://127.0.0.1:${local.port}${health}`)
    expect([reply.status, JSON.parse(reply.body), reply.end]).toEqual([
      direct.status,
      await direct.json(),
      { kind: 'end' },
    ])
    expect(Buffer.concat(payloads(2)).toString()).not.toContain('"ok"')

    send(conn, { type: 'http.sealed', id: 3, data })
    await ended(3)
    expect(of(3).find((f) => f.type === 'http.response')).toMatchObject({ status: 400 })
    e2eSessions.closeAll()
    const after = await sealedEnvelope(session, sessionId, 2, {
      ...request,
      headers: await keyHeaders(key, 'GET', health),
    })
    send(conn, { type: 'http.sealed', id: 4, data: after.data })
    await ended(4)
    expect(of(4).find((f) => f.type === 'http.response')).toMatchObject({ status: 409 })
  })
})
