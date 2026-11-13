import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import {
  ACCESS_KEY_HEADER,
  CLOSE_ACCESS_DENIED,
  CLOSE_DEVICE_NOT_APPROVED,
  DEVICE_NOT_APPROVED_CODE,
  DEVICE_PROOF_HEADER,
  E2E_SESSION_UNKNOWN_CODE,
  E2eError,
  RELAY_TICKET_HEADER,
} from '@orch/shared'
import { e2eMachine, HANDSHAKE, outcome, payloadOf, servers } from '../test/e2eMachine'

// The remote transport with a pinned machine key: the end-to-end handshake, then every request sealed on its own
// channel, against a fake machine behind the relay that plays the host's side. Sealed sockets are in
// `transport.e2e-socket.test.ts`.

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
  setSystemTime()
})

describe('the remote transport with a pinned machine key', () => {
  test('one shared handshake comes before the first request and socket, and a new one before the session expires', async () => {
    const { seen, state, transport: make } = await e2eMachine()
    state.answer = { kind: 'session', ttlMs: 20_000 }
    const transport = await make()
    const [first, second, socket] = await Promise.all([
      transport.request('/api/health', {}),
      transport.request('/api/daemon', {}),
      outcome(transport.openSocket('/ws/events')),
    ])
    expect([first.status, second.status, socket]).toEqual([200, 200, 'open'])
    expect(seen[0]).toBe(HANDSHAKE)
    expect(seen.slice(1).sort()).toEqual(['GET /api/daemon', 'GET /api/health', 'WS /ws/events'])

    await transport.request('/api/health', {})
    expect(seen.filter((line) => line === HANDSHAKE)).toHaveLength(1)
    // Inside the margin before it expires, the next call opens a new session first.
    setSystemTime(new Date(Date.now() + 6_000))
    await transport.request('/api/health', {})
    expect(seen.slice(-2)).toEqual([HANDSHAKE, 'GET /api/health'])
  })

  test('a refused handshake answers requests with its status and fails sockets with the code the page knows, then retries', async () => {
    const { seen, state, transport: make } = await e2eMachine()
    const transport = await make()
    state.answer = { kind: 'refuse', status: 401 }
    const refused = await transport.request('/api/health', {})
    expect(refused.status).toBe(401)
    expect(await outcome(transport.openSocket('/ws/events'))).toBe(CLOSE_ACCESS_DENIED)
    state.answer = { kind: 'refuse', status: 403, body: { error: 'wait', code: DEVICE_NOT_APPROVED_CODE } }
    const [unapproved, socket] = await Promise.all([
      transport.request('/api/health', {}),
      outcome(transport.openSocket('/ws/events')),
    ])
    expect([unapproved.status, await unapproved.json(), socket]).toEqual([
      403,
      { error: 'wait', code: DEVICE_NOT_APPROVED_CODE },
      CLOSE_DEVICE_NOT_APPROVED,
    ])
    state.answer = { kind: 'refuse', status: 500 }
    expect(await outcome(transport.openSocket('/ws/events'))).toBe(1006)
    expect(seen).toEqual([HANDSHAKE, HANDSHAKE, HANDSHAKE, HANDSHAKE])

    state.answer = { kind: 'session', ttlMs: 60_000 }
    expect((await transport.request('/api/health', {})).status).toBe(200)
    expect(seen.slice(-2)).toEqual([HANDSHAKE, 'GET /api/health'])
  })

  test('an answer that does not verify stops the transport for good and reports it once', async () => {
    for (const kind of ['other key', 'other hello', 'bad shape'] as const) {
      const { seen, state, transport: make } = await e2eMachine()
      state.answer = { kind }
      let reported = 0
      const transport = await make({ onMachineUnverified: () => reported++ })
      const [request, socket] = await Promise.allSettled([
        transport.request('/api/health', {}),
        outcome(transport.openSocket('/ws/events')),
      ])
      expect(request.status === 'rejected' && request.reason).toBeInstanceOf(E2eError)
      expect(socket).toEqual({ status: 'fulfilled', value: 1006 })

      state.answer = { kind: 'session', ttlMs: 60_000 }
      await expect(transport.request('/api/health', {})).rejects.toBeInstanceOf(E2eError)
      expect(await outcome(transport.openSocket('/ws/events'))).toBe(1006)
      expect([kind, seen, reported]).toEqual([kind, [HANDSHAKE], 1])
    }
  })

  test('each request goes sealed as one POST, with no credential in its headers or in clear in its body', async () => {
    const { seen, sealed, state, transport: make } = await e2eMachine()
    const transport = await make()
    state.delayMs = { '/api/slow': 40 }
    const [slow, fast, posted] = await Promise.all([
      transport.request('/api/slow?cwd=%2Fsecret', {}),
      transport.request('/api/fast', {}),
      transport.request('/api/fs/make-dir', { method: 'post', body: '{"path":"/tmp/x"}' }),
    ])
    expect(await Promise.all([slow, fast, posted].map((r) => r.text()))).toEqual(['ok', 'ok', 'ok'])
    expect(slow.headers.get('x-inner')).toBe('/api/slow?cwd=%2Fsecret')
    expect(seen.slice(0, 1)).toEqual([HANDSHAKE])
    expect(sealed.map((s) => s.inner.method).sort()).toEqual(['GET', 'GET', 'POST'])
    expect(sealed.find((s) => s.inner.method === 'POST')?.inner.body).toBe('{"path":"/tmp/x"}')

    for (const { headers, raw, inner } of sealed) {
      expect([ACCESS_KEY_HEADER, RELAY_TICKET_HEADER, DEVICE_PROOF_HEADER].some((name) => headers.has(name))).toBe(
        false,
      )
      expect(new Headers(inner.headers).get(ACCESS_KEY_HEADER)).toBe('k')
      expect(payloadOf(new Headers(inner.headers).get(DEVICE_PROOF_HEADER) ?? '')).toMatchObject({
        method: inner.method,
        path: inner.path,
      })
      const clear = Buffer.from(raw).toString('latin1')
      expect(['/api/', 'secret', 'make-dir', 'tmp'].some((text) => clear.includes(text))).toBe(false)
    }
    await transport.request('/api/health', {})
    // One session, and its channels rise from 1 and are never reused.
    expect(new Set(sealed.map((s) => s.sessionId)).size).toBe(1)
    expect(sealed.map((s) => s.channel).sort()).toEqual([1, 2, 3, 4])
  })

  test('an outer refusal comes back as it is, and an unknown session is dropped for the next call without a retry', async () => {
    const { seen, state, transport: make } = await e2eMachine()
    const transport = await make()
    for (const status of [403, 413, 429, 502, 504]) {
      state.outer = { status, body: { error: `outer ${status}` } }
      const response = await transport.request('/api/health', {})
      expect([response.status, await response.json()]).toEqual([status, { error: `outer ${status}` }])
    }
    expect(seen).toEqual([HANDSHAKE])

    state.outer = { status: 409, body: { error: 'gone', code: E2E_SESSION_UNKNOWN_CODE } }
    const unknown = await transport.request('/api/health', {})
    expect([unknown.status, (await unknown.json()).code]).toEqual([409, E2E_SESSION_UNKNOWN_CODE])
    expect(seen).toEqual([HANDSHAKE])
    state.outer = null
    expect(await (await transport.request('/api/health', {})).text()).toBe('ok')
    expect(seen).toEqual([HANDSHAKE, HANDSHAKE, 'GET /api/health'])
  })

  test('a reply whose head does not open rejects, and a mangled body never ends cleanly', async () => {
    const { state, transport: make } = await e2eMachine()
    const transport = await make()
    state.chunks = ['one', 'two']
    state.tamper = 'bad head'
    await expect(transport.request('/api/health', {})).rejects.toBeInstanceOf(E2eError)
    for (const tamper of ['bad body', 'reorder', 'truncate', 'end error'] as const) {
      state.tamper = tamper
      const response = await transport.request('/api/health', {})
      expect([tamper, response.status]).toEqual([tamper, 200])
      const outcome = await response.text().then(
        (text) => `ended: ${text}`,
        (error: unknown) => error,
      )
      expect([tamper, outcome]).toEqual([tamper, expect.any(E2eError)])
    }
    state.tamper = null
    expect(await (await transport.request('/api/health', {})).text()).toBe('onetwo')
  })
})
