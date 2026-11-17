import { describe, expect, test } from 'bun:test'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type AppState,
  auditLogResponse,
  buildSocketUrl,
  CLOSE_ACCESS_DENIED,
  DEVICE_NOT_APPROVED_CODE,
  DEVICE_PROOF_HEADER,
  decodeFrame,
  disconnectResponse,
  encodeFrame,
  machineFingerprint,
  machineIdFromPublicKey,
  machineKeyResponse,
  openE2eSessionResponse,
  RELAY_TICKET_HEADER,
  remoteAccessStatus,
  routes,
  serverFrame,
  startBrowserHandshake,
} from '@orch/shared'
import {
  ACCOUNT_ID,
  accountHeaders,
  accountTicket,
  clients,
  conns,
  dataOn,
  device,
  dir,
  e2eSessions,
  hub,
  local,
  machineId,
  machineKey,
  openE2eSession,
  openLocal,
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
import {
  helloVerifies,
  openSealedReply,
  sealedEnvelope,
  sealedUncheckedSocketEnvelope,
} from './modules/tunnel/tunnel.testing'
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

  test('an access key an older host saved opens nothing: a request or socket presenting it is refused, and its file stays as it was', async () => {
    const conn = await welcomed()
    // The file older hosts kept their access keys in, in its old format, holding a key one would have accepted.
    const file = join(dir, 'access-keys.json')
    const key = randomBytes(32).toString('base64url')
    const hash = createHash('sha256').update(key).digest('base64url')
    const createdAt = new Date().toISOString()
    const saved = `${JSON.stringify({ keys: [{ id: 'k1', name: 'default', hash, createdAt, lastUsedAt: null }] }, null, 2)}\n`
    writeFileSync(file, saved, { mode: 0o600 })
    const path = routes.system.machineKey.path
    const proof = await device.proof({ machineId, method: 'GET', path })
    const headers: [string, string][] = [
      ['x-orch-access-key', key],
      [DEVICE_PROOF_HEADER, proof],
    ]
    send(conn, { type: 'http.request', id: 1, method: 'GET', path, headers })
    const of = (id: number) => conn.frames.filter((f) => 'id' in f && f.id === id)
    await until(() => of(1).some((f) => f.type === 'http.end'))
    expect(of(1).map((f) => f.type)).toEqual(['auth.failed', 'http.response', 'http.end'])
    expect(of(1).find((f) => f.type === 'http.response')).toMatchObject({ status: 401, headers: [] })

    // A sealed socket whose auth message presents the key, on a session the account opened.
    const e2e = await openE2eSession(conn, 2)
    const socketPath = '/ws/term/t1'
    const open = { path: socketPath, auth: { type: 'auth', key, device: await device.socket(machineId, socketPath) } }
    const sealed = await sealedUncheckedSocketEnvelope(e2e.session, e2e.sessionId, e2e.next(), open)
    send(conn, { type: 'ws.sealed', channel: 1, data: sealed.data })
    await until(() => conn.frames.some((f) => f.type === 'ws.close' && f.channel === 1))
    expect(conn.frames.filter((f) => f.type === 'auth.failed' && f.channel === 1)).toHaveLength(1)
    expect(conn.frames.find((f) => f.type === 'ws.close')).toMatchObject({ channel: 1, code: CLOSE_ACCESS_DENIED })
    expect(stub.attached.size).toBe(0)

    const log = await fetch(`http://127.0.0.1:${local.port}${routes.remoteAccess.auditLog.path}`)
    const { entries } = auditLogResponse.parse(await log.json())
    expect(entries.map((entry) => (entry.kind === 'refused' ? entry.reason : entry.kind))).toEqual([
      'no_auth',
      'ticket_refused',
    ])
    expect(readFileSync(file, 'utf8')).toBe(saved)
  })

  test('the agent reporting channel is out of reach: tunneled and local requests touch no session', async () => {
    const conn = await welcomed()
    const event = JSON.stringify({ agent: 'claude', state: 'working', reason: 'tool' })
    const body = new TextEncoder().encode(event)
    const request = async (id: number, path: string) => {
      const headers: [string, string][] = [
        ...(await accountHeaders('POST', path, event)),
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

  test('the host answers the challenge with its public key only, under the id the server and status both use', async () => {
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
      [1, await accountHeaders('GET', path)],
      [
        2,
        [
          [RELAY_TICKET_HEADER, accountTicket()],
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

  test('every remote access route and the instance id answer 403 through the tunnel and leave the setting and tunnel alone, but work locally', async () => {
    const conn = await welcomed()
    const saved = readFileSync(settingsFile, 'utf8')
    const { status, disconnect } = routes.remoteAccess
    const e2e = await openE2eSession(conn, 1)
    for (const [index, endpoint] of [...Object.values(routes.remoteAccess), routes.system.instance].entries()) {
      const reply = await sealedRequest(conn, e2e, index + 2, endpoint.method, endpoint.path)
      expect([endpoint.path, reply.status]).toEqual([endpoint.path, 403])
    }
    expect(conn.frames.some((f) => f.type.startsWith('enroll.') || f.type === 'unlink')).toBe(false)
    expect(readFileSync(settingsFile, 'utf8')).toBe(saved)
    expect(clients).toHaveLength(1)
    expect(clients[0]?.status).toBe('connected')

    const instance = await fetch(`http://127.0.0.1:${local.port}${routes.system.instance.path}`)
    expect(await instance.json()).toEqual({ instanceId: 'test-instance' })
    const near = await fetch(`http://127.0.0.1:${local.port}${status.path}`)
    const text = await near.text()
    expect(remoteAccessStatus.parse(JSON.parse(text))).toEqual({
      serverUrl: `ws://127.0.0.1:${server.port}`,
      serverUrlIsDefault: false,
      defaultServerUrl: 'wss://orch.example.com',
      serverUrlSetBy: null,
      machineId,
      machineFingerprint: machineFingerprint(machineId),
      tunnel: 'connected',
      linkedAccount: {
        name: 'Ada',
        maskedEmail: 'a***@example.com',
        serverUrl: `ws://127.0.0.1:${server.port}`,
        linkedAt: expect.any(String),
      },
      connectRequest: null,
      connectOutcome: null,
    })
    for (const hidden of [machineKey.privateKey, machineKey.pem, ACCOUNT_ID]) {
      expect(text).not.toContain(hidden)
    }

    const off = await fetch(`http://127.0.0.1:${local.port}${disconnect.path}`, {
      method: disconnect.method,
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(disconnectResponse.parse(await off.json())).toMatchObject({
      removedFromAccount: true,
      status: { tunnel: 'off', linkedAccount: null, serverUrl: `ws://127.0.0.1:${server.port}` },
    })
    expect(clients[0]?.status).toBe('off')
    expect(existsSync(join(dir, 'linked-account.json'))).toBe(false)
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
        headers: [['content-type', 'application/json'], ...(headers ?? (await accountHeaders(method, path, body)))],
        body: encoder.encode(body),
      })
    const strangerHeaders = async (body: string): Promise<[string, string][]> => [
      [RELAY_TICKET_HEADER, accountTicket()],
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
    expect(kept?.principal).toMatchObject({ kind: 'account', accountId: ACCOUNT_ID, deviceId: device.id })
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
    const request = { method: 'GET', path: health, headers: await accountHeaders('GET', health) }
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
      headers: await accountHeaders('GET', health),
    })
    send(conn, { type: 'http.sealed', id: 4, data: after.data })
    await ended(4)
    expect(of(4).find((f) => f.type === 'http.response')).toMatchObject({ status: 409 })
  })
})
