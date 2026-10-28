import { describe, expect, test } from 'bun:test'
import { encodeFrame, HOST_PORT, MAX_TUNNEL_FRAME_BYTES, type MachineFrame, routes } from '@orch/shared'
import type { SessionManager } from '@orch/terminal'
import { type AppDeps, createApp } from '../../app'
import { MAX_BODY_CHUNK_BYTES, type TunnelHandler, TunnelHttp } from './tunnel-http.service'

function setup(handle: TunnelHandler) {
  const frames: MachineFrame[] = []
  const http = new TunnelHttp(handle, (frame) => frames.push(frame))
  const request = (id: number, path: string, rest: { method?: string; body?: Uint8Array<ArrayBuffer> } = {}) =>
    http.request({ type: 'http.request', id, method: rest.method ?? 'GET', path, headers: [], body: rest.body })
  return { http, frames, request }
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
  test('answers like a direct app.fetch', async () => {
    const sessions = { list: () => [] } as unknown as SessionManager
    const { app } = createApp({ sessions, daemonStartedAt: () => null } as AppDeps)
    let seen: Request | undefined
    const { frames, request } = setup(async (req) => {
      seen = req
      return app.fetch(req)
    })
    request(1, `${routes.system.health.path}?probe=1`)
    await until(() => ended(frames, 1))

    expect(seen?.url).toBe(`http://127.0.0.1:${HOST_PORT}/api/health?probe=1`)
    const direct = await app.fetch(new Request(`http://127.0.0.1:${HOST_PORT}${routes.system.health.path}`))
    expect(frames[0]).toMatchObject({ type: 'http.response', id: 1, status: direct.status })
    expect(JSON.parse(bodyOf(frames, 1))).toEqual(await direct.json())
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
