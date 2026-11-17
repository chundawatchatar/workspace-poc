import { describe, expect, test } from 'bun:test'
import {
  DEVICE_NOT_APPROVED_CODE,
  DEVICE_PROOF_HEADER,
  E2E_SESSION_UNKNOWN_CODE,
  type E2eChannel,
  type E2eHttpRequest,
  type MachineFrame,
  RELAY_TICKET_HEADER,
} from '@orch/shared'
import { HOST_ORIGIN } from '../../lib/localOrigin'
import type { Principal } from '../../lib/principal'
import type { AuditEvent } from '../remote-access/audit-log.service'
import { openSealedReply, sealedEnvelope, testE2ePair } from './tunnel.testing'
import { type Authorize, DEVICE_NOT_APPROVED, type TunnelHandler, TunnelHttp } from './tunnel-http.service'

// `TunnelHttp.sealed`: requests opened from their seal, authorized like plain ones, and answered sealed.

const principal: Principal = { kind: 'account', accountId: 'u1', deviceId: 'd1', ticketExp: 0 }
const allowAll: Authorize = () => principal

async function until(check: () => boolean, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await Bun.sleep(2)
  }
}

const ended = (frames: MachineFrame[], id: number) => frames.some((f) => f.type === 'http.end' && f.id === id)

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

  const health = (headers: [string, string][] = [[RELAY_TICKET_HEADER, 'good']]): E2eHttpRequest => ({
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
        [RELAY_TICKET_HEADER, 'good'],
        [DEVICE_PROOF_HEADER, 'p'],
        ['x-a', 'b'],
      ]),
    )

    expect(seen).toHaveLength(1)
    expect(seen[0]?.principal).toEqual(principal)
    expect(seen[0]?.url).toBe(`${HOST_ORIGIN}/api/health`)
    expect([RELAY_TICKET_HEADER, DEVICE_PROOF_HEADER].some((name) => seen[0]?.headers.has(name))).toBe(false)
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
    // `good` is the ticket of the session's own access; `other` authorizes another device and `other-account`
    // another account through the same device.
    const authorize: Authorize = ({ ticket }, refused) => {
      if (ticket === 'good') return principal
      if (ticket === 'other') return { ...principal, deviceId: 'd2' }
      if (ticket === 'other-account') return { ...principal, accountId: 'u2' }
      if (ticket === 'new') return DEVICE_NOT_APPROVED
      refused?.({ reason: 'ticket_refused' })
      return null
    }
    const { post, reply, of, http, live, audit, frames } = await sealedSetup(async () => {
      calls++
      return new Response('ok')
    }, authorize)

    const bad = await post(1, 1, health([[RELAY_TICKET_HEADER, 'bad']]))
    expect(of(1)[0]).toEqual({ type: 'auth.failed', id: 1 })
    expect(await reply(1, bad.channel)).toMatchObject({ outer: { status: 200 }, status: 401, end: { kind: 'end' } })
    expect(audit).toEqual([{ kind: 'refused', reason: 'ticket_refused' }])

    const waiting = await post(2, 2, health([[RELAY_TICKET_HEADER, 'new']]))
    const unapproved = await reply(2, waiting.channel)
    expect([unapproved.status, JSON.parse(unapproved.body).code]).toEqual([403, DEVICE_NOT_APPROVED_CODE])
    expect(of(2).some((f) => f.type === 'auth.failed')).toBe(false)

    for (const [id, presented] of [
      [3, 'other'],
      [4, 'other-account'],
    ] as const) {
      const { channel } = await post(id, id, health([[RELAY_TICKET_HEADER, presented]]))
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
