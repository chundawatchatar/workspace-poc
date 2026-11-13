import { describe, expect, test } from 'bun:test'
import {
  ACCESS_KEY_HEADER,
  DEVICE_NOT_APPROVED_CODE,
  DEVICE_PROOF_HEADER,
  E2E_REQUIRED_CODE,
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
import {
  type Authorize,
  bodySha256,
  type Credentials,
  DEVICE_NOT_APPROVED,
  MAX_BODY_CHUNK_BYTES,
  type TunnelHandler,
  TunnelHttp,
  tunneledRequest,
} from './tunnel-http.service'

const principal: Principal = { kind: 'key', keyId: 'k1', name: 'default', deviceId: 'd1' }
const allowAll: Authorize = () => principal

/** The two routes served unsealed through the tunnel, as their exact paths. */
const MACHINE_KEY = routes.system.machineKey.path
const E2E_OPEN = routes.e2e.open.path

function setup(handle: TunnelHandler, authorize = allowAll) {
  const frames: MachineFrame[] = []
  const audit: AuditEvent[] = []
  const http = new TunnelHttp(
    handle,
    authorize,
    (frame) => frames.push(frame),
    undefined,
    (event) => audit.push(event),
  )
  /** A plain GET of the key bootstrap, or with `body` a plain POST of the handshake. */
  const request = (id: number, body?: Uint8Array<ArrayBuffer>) =>
    http.request({
      type: 'http.request',
      id,
      method: body ? 'POST' : 'GET',
      path: body ? E2E_OPEN : MACHINE_KEY,
      headers: [],
      body,
    })
  return { http, frames, audit, request }
}

/** The host's app with stub deps, as `index.ts` hands it to the tunnel. */
function hostApp() {
  const sessions = { list: () => [] } as unknown as SessionManager
  const { app } = createApp({
    sessions,
    daemonStartedAt: () => null,
    machinePublicKey: () => 'the-public-key',
  } as AppDeps)
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
  test('refuses every plain request but the two bootstrap routes with 403 e2e_required, before any credential', async () => {
    let handled = 0
    const asked: Credentials[] = []
    const { http, frames, audit } = setup(
      async () => {
        handled++
        return new Response('ok')
      },
      (credentials) => {
        asked.push(credentials)
        return principal
      },
    )
    const good: [string, string][] = [
      [ACCESS_KEY_HEADER, 'good'],
      [DEVICE_PROOF_HEADER, 'p-good'],
    ]
    const refused: [string, string, [string, string][]][] = [
      ['GET', routes.system.health.path, good],
      ['GET', routes.system.health.path, []],
      ['POST', routes.access.rotate.path, [[RELAY_TICKET_HEADER, 't-good'], ...good.slice(1)]],
      // The exempt paths with a query string, another method, or another spelling.
      ['GET', `${MACHINE_KEY}?probe=1`, good],
      ['POST', MACHINE_KEY, good],
      ['OPTIONS', MACHINE_KEY, [['access-control-request-method', 'GET']]],
      ['get', MACHINE_KEY, good],
      ['GET', `${MACHINE_KEY}/`, good],
      ['GET', E2E_OPEN, good],
      ['POST', `${E2E_OPEN}#x`, good],
    ]
    for (const [i, [method, path, headers]] of refused.entries()) {
      http.request({ type: 'http.request', id: i + 1, method, path, headers })
    }
    const ids = refused.map((_, i) => i + 1)
    await until(() => ids.every((id) => ended(frames, id)))

    expect([handled, asked]).toEqual([0, []])
    expect(frames.some((f) => f.type === 'auth.failed')).toBe(false)
    for (const id of ids) {
      expect(frames.filter((f) => 'id' in f && f.id === id).map((f) => f.type)).toEqual([
        'http.response',
        'http.body',
        'http.end',
      ])
      expect(frames.find((f) => f.type === 'http.response' && f.id === id)).toMatchObject({
        status: 403,
        headers: [['content-type', 'application/json']],
      })
      expect(JSON.parse(bodyOf(frames, id))).toMatchObject({ code: E2E_REQUIRED_CODE })
    }
    expect(audit).toEqual(ids.map(() => ({ kind: 'refused', reason: 'unsealed' })))
  })

  test('answers an authorized bootstrap request like a direct app.fetch, even from a foreign origin, without the key header', async () => {
    const { app, handle } = hostApp()
    let seen: { request: Request; principal: Principal } | undefined
    const { http, frames, audit } = setup(async (req, p) => {
      seen = { request: req, principal: p }
      return handle(req, p)
    })
    const headers: [string, string][] = [
      [ACCESS_KEY_HEADER, 'the-key'],
      ['origin', 'https://orch.example'],
    ]
    http.request({ type: 'http.request', id: 1, method: 'GET', path: MACHINE_KEY, headers })
    await until(() => ended(frames, 1))

    expect(seen?.request.url).toBe(`${HOST_ORIGIN}${MACHINE_KEY}`)
    expect(seen?.request.headers.has(ACCESS_KEY_HEADER)).toBe(false)
    expect(seen?.principal).toEqual(principal)
    const direct = await app.fetch(new Request(`${HOST_ORIGIN}${MACHINE_KEY}`))
    expect(frames[0]).toMatchObject({ type: 'http.response', id: 1, status: direct.status })
    expect(JSON.parse(bodyOf(frames, 1))).toEqual(await direct.json())
    expect(JSON.parse(bodyOf(frames, 1))).toEqual({ publicKey: 'the-public-key' })
    expect(audit).toEqual([])
    // The same foreign origin without the tunnel's authorization is still refused.
    const foreign = await app.fetch(new Request(`${HOST_ORIGIN}${MACHINE_KEY}`, { headers: [headers[1]] }))
    expect(foreign.status).toBe(403)
  })

  test('refuses a missing, wrong, repeated or ticket-rescued key, or one without a proof, with auth.failed, 401 and end, never calling handle', async () => {
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
    const { http, frames, audit } = setup(async (request, p) => {
      handled.push(p)
      handledHeaders.push(request.headers)
      return new Response('ok')
    }, authorize)
    const send = (id: number, headers: [string, string][]) =>
      http.request({ type: 'http.request', id, method: 'GET', path: MACHINE_KEY, headers })
    send(1, [])
    send(2, [[ACCESS_KEY_HEADER, 'bad']])
    send(3, [
      [ACCESS_KEY_HEADER, 'good'],
      [ACCESS_KEY_HEADER, 'good'],
    ])
    // With a key header the key alone decides, even when the ticket and proof would pass.
    send(5, [
      [ACCESS_KEY_HEADER, 'bad'],
      [RELAY_TICKET_HEADER, 't-good'],
      [DEVICE_PROOF_HEADER, 'p-good'],
    ])
    send(6, [[RELAY_TICKET_HEADER, 't-bad']])
    send(7, [[RELAY_TICKET_HEADER, 't-good']])
    // The handshake, with its body in the proof.
    const body = new TextEncoder().encode('{"a":1}')
    http.request({
      type: 'http.request',
      id: 8,
      method: 'POST',
      path: E2E_OPEN,
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
    const ids = [1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12]
    await until(() => ids.every((id) => ended(frames, id)))

    expect(handled).toEqual([{ kind: 'account', accountId: 'u1', deviceId: 'd1', ticketExp: 0 }, principal])
    // The key, ticket and proof have done their job, so the handler never sees them.
    for (const headers of handledHeaders) {
      expect([ACCESS_KEY_HEADER, RELAY_TICKET_HEADER, DEVICE_PROOF_HEADER].some((name) => headers.has(name))).toBe(
        false,
      )
    }
    const emptyHash = bodySha256()
    const proofOf = (proof: string) => ({ proof, method: 'GET', path: MACHINE_KEY, bodySha256: emptyHash })
    expect(seen).toEqual([
      { key: null, ticket: null, device: null },
      { key: 'bad', ticket: null, device: null },
      { key: null, ticket: null, device: null },
      { key: 'bad', ticket: null, device: proofOf('p-good') },
      { key: null, ticket: 't-bad', device: null },
      { key: null, ticket: 't-good', device: null },
      {
        key: null,
        ticket: 't-good',
        device: { proof: 'p-good', method: 'POST', path: E2E_OPEN, bodySha256: bodySha256(body) },
      },
      { key: null, ticket: 't-good', device: proofOf('p-new') },
      { key: 'good', ticket: null, device: null },
      { key: 'good', ticket: null, device: proofOf('p-new') },
      { key: 'good', ticket: null, device: proofOf('p-good') },
    ])
    for (const id of [1, 2, 3, 5, 6, 7, 10]) {
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
    // This stub gives no reasons, so each refusal falls back to the credential it was given.
    expect(audit.map((event) => (event.kind === 'refused' ? event.reason : event.kind))).toEqual([
      'ticket_refused',
      'key_refused',
      'ticket_refused',
      'key_refused',
      'ticket_refused',
      'ticket_refused',
      'device_not_approved',
      'key_refused',
      'device_not_approved',
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
      path: E2E_OPEN,
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
    const { frames, request } = setup(async (req) => new Response(req.method === 'GET' ? big : 'small'))
    request(1)
    request(2, new TextEncoder().encode('{}'))
    await until(() => ended(frames, 1) && ended(frames, 2))

    expect(bodyOf(frames, 1)).toBe(big)
    expect(bodyOf(frames, 2)).toBe('small')
    for (const frame of frames) {
      if (frame.type === 'http.body') expect(frame.data.byteLength).toBeLessThanOrEqual(MAX_BODY_CHUNK_BYTES)
      expect(encodeFrame(frame).length).toBeLessThan(MAX_TUNNEL_FRAME_BYTES)
    }
  })

  test('turns handler failures into 500 and a failed body into an end with an error', async () => {
    const { frames, request } = setup(async (req) => {
      if (req.method === 'GET') throw new Error('boom')
      return new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new TextEncoder().encode('partial'))
            controller.error(new Error('disk gone'))
          },
        }),
      )
    })
    request(1)
    request(2, new TextEncoder().encode('{}'))
    await until(() => [1, 2].every((id) => ended(frames, id)))

    expect(frames.find((f) => f.type === 'http.response' && f.id === 1)).toMatchObject({ status: 500 })
    expect(frames.find((f) => f.type === 'http.response' && f.id === 2)).toMatchObject({ status: 200 })
    expect(frames.find((f) => f.type === 'http.end' && f.id === 2)).toMatchObject({ error: 'response body failed' })
  })

  test('tunneledRequest refuses escaping paths, a GET with a body and headers the Request rejects', () => {
    const frame = (path: string, rest: { headers?: [string, string][]; body?: Uint8Array<ArrayBuffer> } = {}) =>
      tunneledRequest({ type: 'http.request', id: 1, method: 'GET', path, headers: rest.headers ?? [], ...rest })
    expect(frame('/api/../ws/terminal')).toBeNull()
    expect(frame('/api/%2e%2e/')).toBeNull()
    expect(frame('/api/health', { body: new TextEncoder().encode('x') })).toBeNull()
    expect(frame('/api/health', { headers: [['bad name', '1']] })).toBeNull()
    expect(frame('/api/health?x=1')?.url).toBe(`${HOST_ORIGIN}/api/health?x=1`)
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
    request(1)
    request(1)
    await until(() => frames.some((f) => f.type === 'http.body'))
    http.close()
    await until(() => cancelled)

    expect(calls).toBe(1)
    expect(signal?.aborted).toBe(true)
    expect(frames.map((f) => f.type)).toEqual(['http.response', 'http.body'])
  })
})
