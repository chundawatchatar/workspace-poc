import { describe, expect, test } from 'bun:test'
import {
  ACCESS_KEY_HEADER,
  DEVICE_NOT_APPROVED_CODE,
  DEVICE_PROOF_HEADER,
  E2E_SESSION_UNKNOWN_CODE,
  type E2eChannel,
  type E2eHttpRequest,
  encodeFrame,
  MAX_TUNNEL_FRAME_BYTES,
  type MachineFrame,
  RELAY_TICKET_HEADER,
  routes,
} from '@orch/shared'
import type { SessionManager } from '@orch/terminal'
import { type AppDeps, createApp } from '../../app'
import { HOST_ORIGIN } from '../../lib/localOrigin'
import { type Principal, tunnelEnv } from '../../lib/principal'
import type { AuditEvent } from '../remote-access/audit-log.service'
import { openSealedReply, sealedEnvelope, testE2ePair } from './tunnel.testing'
import {
  type Authorize,
  bodySha256,
  type Credentials,
  DEVICE_NOT_APPROVED,
  MAX_BODY_CHUNK_BYTES,
  type TunnelHandler,
  TunnelHttp,
} from './tunnel-http.service'

const principal: Principal = { kind: 'key', keyId: 'k1', name: 'default', deviceId: 'd1' }
const allowAll: Authorize = () => principal

function setup(handle: TunnelHandler, authorize = allowAll) {
  const frames: MachineFrame[] = []
  const http = new TunnelHttp(handle, authorize, (frame) => frames.push(frame))
  const request = (id: number, path: string, rest: { method?: string; body?: Uint8Array<ArrayBuffer> } = {}) =>
    http.request({ type: 'http.request', id, method: rest.method ?? 'GET', path, headers: [], body: rest.body })
  return { http, frames, request }
}

/** The host's app with stub deps, as `index.ts` hands it to the tunnel. */
function hostApp() {
  const sessions = { list: () => [] } as unknown as SessionManager
  const { app } = createApp({ sessions, daemonStartedAt: () => null } as AppDeps)
  const handle: TunnelHandler = async (request, p) => app.fetch(request, tunnelEnv(p))
  return { app, handle }
}

async function until(check: () => boolean, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await Bun.sleep(2)
  }
}

const ended = (frames: MachineFrame[], id: number) => frames.some((f) => f.type === 'http.end' && f.id === id)

/** The response body, put back together from its `http.body` frames. */
function bodyOf(frames: MachineFrame[], id: number) {
  const chunks = frames.flatMap((f) => (f.type === 'http.body' && f.id === id ? [f.data] : []))
  return Buffer.concat(chunks).toString()
}

describe('TunnelHttp', () => {
  test('answers an authorized request like a direct app.fetch, even from a foreign origin, without the key header', async () => {
    const { app, handle } = hostApp()
    let seen: { request: Request; principal: Principal } | undefined
    const { http, frames } = setup(async (req, p) => {
      seen = { request: req, principal: p }
      return handle(req, p)
    })
    const headers: [string, string][] = [
      [ACCESS_KEY_HEADER, 'the-key'],
      ['origin', 'https://orch.example'],
    ]
    http.request({ type: 'http.request', id: 1, method: 'GET', path: `${routes.system.health.path}?probe=1`, headers })
    await until(() => ended(frames, 1))

    expect(seen?.request.url).toBe(`${HOST_ORIGIN}/api/health?probe=1`)
    expect(seen?.request.headers.has(ACCESS_KEY_HEADER)).toBe(false)
    expect(seen?.principal).toEqual(principal)
    const direct = await app.fetch(new Request(`${HOST_ORIGIN}${routes.system.health.path}`))
    expect(frames[0]).toMatchObject({ type: 'http.response', id: 1, status: direct.status })
    expect(JSON.parse(bodyOf(frames, 1))).toEqual(await direct.json())
    // The same foreign origin without the tunnel's authorization is still refused.
    const foreign = await app.fetch(
      new Request(`${HOST_ORIGIN}${routes.system.health.path}`, { headers: [headers[1]] }),
    )
    expect(foreign.status).toBe(403)
  })

  test('refuses a missing, wrong, repeated or query-string key, or one without a proof, with auth.failed, 401 and end, never calling handle', async () => {
    const seen: Credentials[] = []
    // Accepts the key `good`, and the ticket `t-good` as the account `u1`, each with the proof `p-good`; the proof
    // `p-new` stands for a device the machine hasn't approved.
    const authorize: Authorize = (credentials) => {
      seen.push(credentials)
      const { key, ticket, device } = credentials
      if (key === null ? ticket !== 't-good' : key !== 'good') return null
      if (device?.proof === 'p-new') return DEVICE_NOT_APPROVED
      if (device?.proof !== 'p-good') return null
      return key ? principal : { kind: 'account', accountId: 'u1', deviceId: 'd1', ticketExp: 0 }
    }
    const handled: Principal[] = []
    const handledHeaders: Headers[] = []
    const { http, frames } = setup(async (request, p) => {
      handled.push(p)
      handledHeaders.push(request.headers)
      return new Response('ok')
    }, authorize)
    const send = (id: number, headers: [string, string][], path = '/api/health') =>
      http.request({ type: 'http.request', id, method: 'GET', path, headers })
    send(1, [])
    send(2, [[ACCESS_KEY_HEADER, 'bad']])
    send(3, [
      [ACCESS_KEY_HEADER, 'good'],
      [ACCESS_KEY_HEADER, 'good'],
    ])
    send(4, [], `/api/health?${ACCESS_KEY_HEADER}=good&key=good`)
    // With a key header the key alone decides, even when the ticket and proof would pass.
    send(5, [
      [ACCESS_KEY_HEADER, 'bad'],
      [RELAY_TICKET_HEADER, 't-good'],
      [DEVICE_PROOF_HEADER, 'p-good'],
    ])
    send(6, [[RELAY_TICKET_HEADER, 't-bad']])
    send(7, [[RELAY_TICKET_HEADER, 't-good']])
    const body = new TextEncoder().encode('{"a":1}')
    http.request({
      type: 'http.request',
      id: 8,
      method: 'POST',
      path: '/api/git/status?cwd=%2Ftmp',
      headers: [
        [RELAY_TICKET_HEADER, 't-good'],
        [DEVICE_PROOF_HEADER, 'p-good'],
      ],
      body,
    })
    send(9, [
      [RELAY_TICKET_HEADER, 't-good'],
      [DEVICE_PROOF_HEADER, 'p-new'],
    ])
    // A good key needs a proof too: none is refused, a waiting device gets the 403, and an approved one gets in.
    send(10, [[ACCESS_KEY_HEADER, 'good']])
    send(11, [
      [ACCESS_KEY_HEADER, 'good'],
      [DEVICE_PROOF_HEADER, 'p-new'],
    ])
    send(12, [
      [ACCESS_KEY_HEADER, 'good'],
      [DEVICE_PROOF_HEADER, 'p-good'],
    ])
    const ids = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
    await until(() => ids.every((id) => ended(frames, id)))

    expect(handled).toEqual([{ kind: 'account', accountId: 'u1', deviceId: 'd1', ticketExp: 0 }, principal])
    // The key, ticket and proof have done their job, so the handler never sees them.
    for (const headers of handledHeaders) {
      expect([ACCESS_KEY_HEADER, RELAY_TICKET_HEADER, DEVICE_PROOF_HEADER].some((name) => headers.has(name))).toBe(
        false,
      )
    }
    const emptyHash = bodySha256()
    const proofOf = (proof: string) => ({ proof, method: 'GET', path: '/api/health', bodySha256: emptyHash })
    expect(seen).toEqual([
      { key: null, ticket: null, device: null },
      { key: 'bad', ticket: null, device: null },
      { key: null, ticket: null, device: null },
      { key: null, ticket: null, device: null },
      { key: 'bad', ticket: null, device: proofOf('p-good') },
      { key: null, ticket: 't-bad', device: null },
      { key: null, ticket: 't-good', device: null },
      {
        key: null,
        ticket: 't-good',
        device: { proof: 'p-good', method: 'POST', path: '/api/git/status?cwd=%2Ftmp', bodySha256: bodySha256(body) },
      },
      { key: null, ticket: 't-good', device: proofOf('p-new') },
      { key: 'good', ticket: null, device: null },
      { key: 'good', ticket: null, device: proofOf('p-new') },
      { key: 'good', ticket: null, device: proofOf('p-good') },
    ])
    for (const id of [1, 2, 3, 4, 5, 6, 7, 10]) {
      expect(frames.filter((f) => 'id' in f && f.id === id)).toEqual([
        { type: 'auth.failed', id },
        { type: 'http.response', id, status: 401, headers: [] },
        { type: 'http.end', id },
      ])
    }
    // A device waiting for approval is no bad credential: a JSON 403 and no `auth.failed`.
    for (const id of [9, 11]) {
      expect(frames.filter((f) => 'id' in f && f.id === id).map((f) => f.type)).toEqual([
        'http.response',
        'http.body',
        'http.end',
      ])
      expect(frames.find((f) => f.type === 'http.response' && f.id === id)).toMatchObject({ status: 403 })
      expect(JSON.parse(bodyOf(frames, id))).toMatchObject({ code: DEVICE_NOT_APPROVED_CODE })
    }
  })

  test('refuses a CORS preflight without a key like any other request, since the server answers preflights', async () => {
    let calls = 0
    const { http, frames } = setup(
      async () => {
        calls++
        return new Response(null, { status: 204 })
      },
      () => null,
    )
    const preflight: [string, string][] = [
      ['origin', 'http://127.0.0.1:3220'],
      ['access-control-request-method', 'POST'],
      ['access-control-request-headers', ACCESS_KEY_HEADER],
    ]
    http.request({
      type: 'http.request',
      id: 1,
      method: 'OPTIONS',
      path: routes.access.rotate.path,
      headers: preflight,
    })
    await until(() => ended(frames, 1))

    expect(calls).toBe(0)
    expect(frames).toEqual([
      { type: 'auth.failed', id: 1 },
      { type: 'http.response', id: 1, status: 401, headers: [] },
      { type: 'http.end', id: 1 },
    ])
  })

  test('passes the method, headers and body through, and keeps repeated response headers', async () => {
    let seen: { method: string; header: string | null; body: string } | undefined
    const { http, frames } = setup(async (req) => {
      seen = { method: req.method, header: req.headers.get('x-test'), body: await req.text() }
      const headers = new Headers([
        ['set-cookie', 'a=1'],
        ['set-cookie', 'b=2'],
      ])
      return new Response(null, { status: 204, headers })
    })
    http.request({
      type: 'http.request',
      id: 1,
      method: 'POST',
      path: '/api/fs/make-dir',
      headers: [['x-test', 'yes']],
      body: new TextEncoder().encode('{"a":1}'),
    })
    await until(() => ended(frames, 1))

    expect(seen).toEqual({ method: 'POST', header: 'yes', body: '{"a":1}' })
    expect(frames).toEqual([
      {
        type: 'http.response',
        id: 1,
        status: 204,
        headers: [
          ['set-cookie', 'a=1'],
          ['set-cookie', 'b=2'],
        ],
      },
      { type: 'http.end', id: 1 },
    ])
  })

  test('splits a large body into frames of at most 64 KiB, while other requests interleave', async () => {
    const big = 'x'.repeat(3 * MAX_BODY_CHUNK_BYTES + 10)
    const { frames, request } = setup(async (req) => new Response(req.url.endsWith('big') ? big : 'small'))
    request(1, '/api/big')
    request(2, '/api/small')
    await until(() => ended(frames, 1) && ended(frames, 2))

    expect(bodyOf(frames, 1)).toBe(big)
    expect(bodyOf(frames, 2)).toBe('small')
    for (const frame of frames) {
      if (frame.type === 'http.body') expect(frame.data.byteLength).toBeLessThanOrEqual(MAX_BODY_CHUNK_BYTES)
      expect(encodeFrame(frame).length).toBeLessThan(MAX_TUNNEL_FRAME_BYTES)
    }
  })

  test('refuses escaping paths and bad requests with 400, and turns handler failures into 500', async () => {
    let calls = 0
    const { http, frames, request } = setup(async (req) => {
      calls++
      if (req.url.endsWith('throws')) throw new Error('boom')
      return new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new TextEncoder().encode('partial'))
            controller.error(new Error('disk gone'))
          },
        }),
      )
    })
    request(1, '/api/../ws/terminal')
    request(2, '/api/%2e%2e/')
    request(3, '/api/health', { method: 'GET', body: new TextEncoder().encode('x') })
    http.request({ type: 'http.request', id: 6, method: 'GET', path: '/api/health', headers: [['bad name', '1']] })
    request(4, '/api/throws')
    request(5, '/api/stream')
    await until(() => [1, 2, 3, 4, 5, 6].every((id) => ended(frames, id)))

    const head = (id: number) => frames.find((f) => f.type === 'http.response' && f.id === id)
    for (const id of [1, 2, 3, 6]) expect(head(id)).toMatchObject({ status: 400 })
    expect(head(4)).toMatchObject({ status: 500 })
    expect(head(5)).toMatchObject({ status: 200 })
    expect(frames.find((f) => f.type === 'http.end' && f.id === 5)).toMatchObject({ error: 'response body failed' })
    expect(calls).toBe(2)
  })

  test('close aborts requests in flight, cancels their bodies and sends nothing more for them', async () => {
    let signal: AbortSignal | undefined
    let cancelled = false
    let calls = 0
    const { http, frames, request } = setup(async (req) => {
      calls++
      signal = req.signal
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('first'))
          },
          cancel() {
            cancelled = true
          },
        }),
      )
    })
    request(1, '/api/slow')
    request(1, '/api/slow')
    await until(() => frames.some((f) => f.type === 'http.body'))
    http.close()
    await until(() => cancelled)

    expect(calls).toBe(1)
    expect(signal?.aborted).toBe(true)
    expect(frames.map((f) => f.type)).toEqual(['http.response', 'http.body'])
  })
})

describe('TunnelHttp sealed requests', () => {
  const SESSION_ID = 'AAECAwQFBgcICQoLDA0ODw'

  /** A `TunnelHttp` with one live session opened by `owner`, whose `room` counts its calls. */
  async function sealedSetup(handle: TunnelHandler, authorize: Authorize, owner: Principal = principal) {
    const pair = await testE2ePair()
    const frames: MachineFrame[] = []
    const audit: AuditEvent[] = []
    let rooms = 0
    const live = new Map([[SESSION_ID, { principal: owner, session: pair.machine }]])
    const http = new TunnelHttp(
      handle,
      authorize,
      (frame) => frames.push(frame),
      async () => {
        rooms++
      },
      (event) => audit.push(event),
      (id) => live.get(id) ?? null,
    )
    const post = async (id: number, n: number, request: E2eHttpRequest, sessionId = SESSION_ID) => {
      const { channel, data } = await sealedEnvelope(pair.browser, sessionId, n, request)
      http.sealed({ type: 'http.sealed', id, data })
      await until(() => ended(frames, id))
      return { channel, data }
    }
    const of = (id: number) => frames.filter((f) => 'id' in f && f.id === id)
    const reply = async (id: number, channel: E2eChannel) => {
      const outer = of(id).find((f) => f.type === 'http.response')
      const payloads = of(id).flatMap((f) => (f.type === 'http.body' ? [f.data] : []))
      return { outer, ...(await openSealedReply(channel, payloads)) }
    }
    return { http, frames: () => frames, audit, live, post, of, reply, rooms: () => rooms }
  }

  const health = (headers: [string, string][] = [[ACCESS_KEY_HEADER, 'good']]): E2eHttpRequest => ({
    method: 'GET',
    path: '/api/health',
    headers,
  })

  test('a sealed request reaches the handler as the session principal without credentials, and streams back sealed', async () => {
    const seen: { principal: Principal; headers: Headers; url: string }[] = []
    const {
      post,
      reply,
      frames: allFrames,
      rooms,
    } = await sealedSetup(async (request, p) => {
      seen.push({ principal: p, headers: request.headers, url: request.url })
      const encoder = new TextEncoder()
      return new Response(
        new ReadableStream({
          start(controller) {
            for (const chunk of ['one-', 'two-', 'three']) controller.enqueue(encoder.encode(chunk))
            controller.close()
          },
        }),
        { status: 201, headers: { 'x-n': '1' } },
      )
    }, allowAll)
    const { channel } = await post(
      1,
      1,
      health([
        [ACCESS_KEY_HEADER, 'good'],
        [DEVICE_PROOF_HEADER, 'p'],
        ['x-a', 'b'],
      ]),
    )

    expect(seen).toHaveLength(1)
    expect(seen[0]?.principal).toEqual(principal)
    expect(seen[0]?.url).toBe(`${HOST_ORIGIN}/api/health`)
    expect([ACCESS_KEY_HEADER, DEVICE_PROOF_HEADER].some((name) => seen[0]?.headers.has(name))).toBe(false)
    expect(seen[0]?.headers.get('x-a')).toBe('b')
    const opened = await reply(1, channel)
    expect(opened.outer).toEqual({
      type: 'http.response',
      id: 1,
      status: 200,
      headers: [['content-type', 'application/octet-stream']],
    })
    expect([opened.status, opened.headers, opened.body, opened.chunks]).toEqual([
      201,
      expect.anything(),
      'one-two-three',
      3,
    ])
    expect(opened.headers).toContainEqual(['x-n', '1'])
    expect(opened.records.map((r) => r.kind)).toEqual(['head', 'body', 'body', 'body', 'end'])
    // Each record is one framed `http.body`, and each waited for room.
    const bodies = allFrames().flatMap((f) => (f.type === 'http.body' ? [f.data] : []))
    expect(bodies).toHaveLength(5)
    expect(rooms()).toBe(5)
    expect(Buffer.concat(bodies).toString()).not.toContain('one-')
  })

  test('refused, unapproved and mismatched requests get sealed answers, and session or envelope trouble an unsealed one', async () => {
    let calls = 0
    // `good` is the session's own key; `other` authorizes another device and `acct` an account.
    const authorize: Authorize = ({ key }, refused) => {
      if (key === 'good') return principal
      if (key === 'other') return { ...principal, deviceId: 'd2' }
      if (key === 'other-key') return { ...principal, keyId: 'k2' }
      if (key === 'acct') return { kind: 'account', accountId: 'u1', deviceId: 'd1', ticketExp: 0 }
      if (key === 'new') return DEVICE_NOT_APPROVED
      refused?.({ reason: 'key_refused' })
      return null
    }
    const { post, reply, of, http, live, audit, frames } = await sealedSetup(async () => {
      calls++
      return new Response('ok')
    }, authorize)

    const bad = await post(1, 1, health([[ACCESS_KEY_HEADER, 'bad']]))
    expect(of(1)[0]).toEqual({ type: 'auth.failed', id: 1 })
    expect(await reply(1, bad.channel)).toMatchObject({ outer: { status: 200 }, status: 401, end: { kind: 'end' } })
    expect(audit).toEqual([{ kind: 'refused', reason: 'key_refused' }])

    const waiting = await post(2, 2, health([[ACCESS_KEY_HEADER, 'new']]))
    const unapproved = await reply(2, waiting.channel)
    expect([unapproved.status, JSON.parse(unapproved.body).code]).toEqual([403, DEVICE_NOT_APPROVED_CODE])
    expect(of(2).some((f) => f.type === 'auth.failed')).toBe(false)

    for (const [id, presented] of [
      [3, 'other'],
      [4, 'other-key'],
      [5, 'acct'],
    ] as const) {
      const { channel } = await post(id, id, health([[ACCESS_KEY_HEADER, presented]]))
      expect((await reply(id, channel)).status).toBe(403)
    }

    const plain = (id: number) => ({
      head: of(id).find((f) => f.type === 'http.response'),
      body: Buffer.concat(of(id).flatMap((f) => (f.type === 'http.body' ? [f.data] : []))).toString(),
    })
    // A session the host doesn't have, whatever the browser thinks.
    await post(6, 6, health(), 'BBECAwQFBgcICQoLDA0ODw')
    expect(plain(6).head).toMatchObject({ status: 409 })
    expect(JSON.parse(plain(6).body)).toMatchObject({ code: E2E_SESSION_UNKNOWN_CODE })
    // A replayed envelope, a malformed one and one that doesn't open.
    const fresh = await post(7, 7, health())
    expect((await reply(7, fresh.channel)).status).toBe(200)
    http.sealed({ type: 'http.sealed', id: 8, data: fresh.data })
    http.sealed({ type: 'http.sealed', id: 9, data: new Uint8Array(10) })
    const tampered = (await sealedEnvelope((await testE2ePair()).browser, SESSION_ID, 10, health())).data
    http.sealed({ type: 'http.sealed', id: 10, data: tampered })
    await until(() => [8, 9, 10].every((id) => ended(frames(), id)))
    for (const id of [8, 9, 10]) expect(plain(id).head).toMatchObject({ status: 400 })

    live.clear()
    await post(11, 11, health())
    expect(plain(11).head).toMatchObject({ status: 409 })
    expect(calls).toBe(1)
  })
})
