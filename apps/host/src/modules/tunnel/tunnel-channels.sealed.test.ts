import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from 'bun:test'
import {
  CLOSE_ACCESS_DENIED,
  CLOSE_DEVICE_NOT_APPROVED,
  CLOSE_E2E_SESSION_UNKNOWN,
  type E2eSession,
  type E2eSocketOpen,
  encodeEnvelope,
  encodeRequestRecord,
  type MachineFrame,
  WS_CHANNEL_WINDOW_BYTES,
} from '@orch/shared'
import type { Principal } from '../../lib/principal'
import type { SocketConn, SocketData } from '../../lib/socket'
import type { AuditEvent } from '../remote-access/audit-log.service'
import { openMessages, sealedSocketEnvelope, sealMessage, testE2ePair } from './tunnel.testing'
import { type OpenSocket, TunnelChannels } from './tunnel-channels.service'
import { type Authorize, type Credentials, DEVICE_NOT_APPROVED } from './tunnel-http.service'

// `TunnelChannels` for `ws.sealed`: sockets opened from their envelope, authorized like plain ones, sealed both ways.

const SESSION_ID = 'AAECAwQFBgcICQoLDA0ODw'
const owner: Principal = { kind: 'key', keyId: 'k1', name: 'default', deviceId: 'd1' }

/** What `authorize` was asked, in order. */
let asked: Credentials[] = []
let warn: Mock<(...args: unknown[]) => void>

beforeEach(() => {
  asked = []
  warn = spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  warn.mockRestore()
})

/**
 * Accepts the key `good` as `owner` and `other` as another key of the same
 * device, and the ticket `t-good` as the account `u1`, each with the proof
 * `p-good`. The proof `p-new` stands for a device the machine hasn't approved.
 */
const authorize: Authorize = (credentials, refused) => {
  asked.push(credentials)
  const { key, ticket, device } = credentials
  if (!(key === 'good' || key === 'other' || (key === null && ticket === 't-good'))) {
    refused?.({ reason: key === null ? 'ticket_refused' : 'key_refused' })
    return null
  }
  if (device?.proof === 'p-new') return DEVICE_NOT_APPROVED
  if (key === 'good') return owner
  if (key === 'other') return { ...owner, keyId: 'k2' }
  return { kind: 'account', accountId: 'u1', deviceId: 'd1', ticketExp: 0 }
}

const keyOpen = (key = 'good', device = 'p-good', path = '/ws/term/t1?cols=80'): E2eSocketOpen => ({
  path,
  auth: { type: 'auth', key, device },
})

interface Run {
  path: string
  headers: [string, string][]
  principal: Principal
  conn: SocketConn
  messages: SocketData[]
  closes: number
}

/** Channels with one live session opened by `owner`, a handler that echoes nothing, and a browser end. */
async function setup(options: { queueCapBytes?: number } = {}) {
  const pair = await testE2ePair()
  const frames: MachineFrame[] = []
  const audit: AuditEvent[] = []
  const runs: Run[] = []
  const live = new Map<string, { principal: Principal; session: E2eSession }>([
    [SESSION_ID, { principal: owner, session: pair.machine }],
  ])
  const openSocket: OpenSocket = (path, headers, conn, principal) => {
    const run: Run = { path, headers, principal, conn, messages: [], closes: 0 }
    runs.push(run)
    return { message: (data) => run.messages.push(data), close: () => run.closes++ }
  }
  const channels = new TunnelChannels(openSocket, authorize, (frame) => frames.push(frame), {
    record: (event) => audit.push(event),
    sessions: (id) => live.get(id) ?? null,
    ...options,
  })
  /** Sends `open` sealed on session channel `n` as tunnel channel `id`, and returns the browser's end. */
  const open = async (id: number, n: number, record: E2eSocketOpen, sessionId = SESSION_ID) => {
    const { channel, data } = await sealedSocketEnvelope(pair.browser, sessionId, n, record)
    channels.receive({ type: 'ws.sealed', channel: id, data })
    return { channel, data }
  }
  const on = (id: number) => frames.filter((f) => 'channel' in f && f.channel === id)
  const payloads = (id: number) => on(id).flatMap((f) => (f.type === 'ws.data' ? [f.data] : []))
  const closeOf = (id: number) => on(id).find((f) => f.type === 'ws.close')
  return { pair, channels, frames, audit, runs, live, open, on, payloads, closeOf }
}

async function until(check: () => boolean, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await Bun.sleep(2)
  }
}

describe('TunnelChannels sealed sockets', () => {
  test('a sealed open runs the handler as the session principal, and messages cross both ways in order, typed', async () => {
    const { pair, channels, runs, payloads, on, audit, closeOf } = await setup()
    const { channel, data: envelope } = await sealedSocketEnvelope(pair.browser, SESSION_ID, 3, keyOpen())
    const early = [await sealMessage(channel, '{"type":"input","data":"a"}'), await sealMessage(channel, 'b')]
    // Received in the same tick as the envelope, so before the open has finished: delivered after it, in order.
    channels.receive({ type: 'ws.sealed', channel: 5, data: envelope })
    for (const data of early) channels.receive({ type: 'ws.data', channel: 5, data })
    expect(runs).toHaveLength(0)
    await until(() => (runs[0]?.messages.length ?? 0) === 2)

    const run = runs[0] as Run
    expect([run.path, run.headers, run.principal]).toEqual(['/ws/term/t1?cols=80', [], owner])
    expect(asked.at(-1)).toMatchObject({ key: 'good', ticket: null, device: { proof: 'p-good', method: 'WS' } })
    expect(asked.at(-1)?.device?.path).toBe('/ws/term/t1?cols=80')
    expect(run.messages).toEqual(['{"type":"input","data":"a"}', 'b'])

    channels.receive({ type: 'ws.data', channel: 5, data: await sealMessage(channel, Uint8Array.of(1, 2)) })
    await until(() => run.messages.length === 3)
    expect(run.messages[2]).toEqual(Uint8Array.of(1, 2))
    // Acks count the sealed bytes delivered: each payload is its message, a tag byte, the counter and the tag.
    await until(() => on(5).some((f) => f.type === 'ws.ack'))
    const acked = on(5).reduce((sum, f) => sum + (f.type === 'ws.ack' ? f.bytes : 0), 0)
    expect(acked).toBe(early.reduce((sum, data) => sum + data.byteLength, 0) + 3 + 24)

    const sizes = [run.conn.send('snapshot'), run.conn.send(Uint8Array.of(27, 91)), run.conn.send('é')]
    expect(sizes).toEqual([8 + 25, 2 + 25, 2 + 25])
    await until(() => payloads(5).length === 3)
    expect(await openMessages(channel, payloads(5))).toEqual(['snapshot', Uint8Array.of(27, 91), 'é'])
    expect(payloads(5).map((p) => (p as Uint8Array).byteLength)).toEqual(sizes)
    expect(Buffer.concat(payloads(5) as Uint8Array[]).toString('latin1')).not.toContain('snapshot')

    expect(channels.list()).toEqual([{ principal: owner, openedAt: expect.any(Number) }])
    channels.closeChannels((p) => p.kind === 'key', 'access denied')
    expect(closeOf(5)).toMatchObject({ code: CLOSE_ACCESS_DENIED })
    expect([run.closes, channels.size]).toEqual([1, 0])
    expect(audit.map((e) => e.kind)).toEqual(['opened', 'closed'])
  })

  test('outgoing messages queue past the window in sealed bytes, report -1, and drain in order on ws.ack', async () => {
    const { channels, runs, open, payloads } = await setup()
    const { channel } = await open(1, 1, keyOpen())
    await until(() => runs.length === 1)
    const conn = (runs[0] as Run).conn
    const quarter = new Uint8Array(WS_CHANNEL_WINDOW_BYTES / 4)
    const results = [0, 1, 2, 3, 4, 5].map((i) => conn.send(quarter.fill(i)))
    const sealed = quarter.byteLength + 25
    // A message may start while the sealed bytes ahead of it are under the window; the rest queue.
    expect(results).toEqual([sealed, sealed, sealed, sealed, -1, -1])
    expect(conn.buffered()).toBe(6 * sealed)
    await until(() => payloads(1).length === 4)
    await Bun.sleep(10)
    expect(payloads(1)).toHaveLength(4)

    channels.receive({ type: 'ws.ack', channel: 1, bytes: 2 * sealed })
    expect(payloads(1)).toHaveLength(6)
    const opened = (await openMessages(channel, payloads(1))) as Uint8Array[]
    expect(opened.map((m) => m[0])).toEqual([0, 1, 2, 3, 4, 5])
    expect(conn.buffered()).toBe(4 * sealed)
  })

  test('refused credentials, devices and principals, and an unknown session, open no handler', async () => {
    const { runs, open, on, closeOf, audit, live } = await setup()
    await open(1, 1, keyOpen('wrong'))
    await open(2, 2, keyOpen('good', 'p-new'))
    await open(3, 3, keyOpen('other'))
    await open(4, 4, { path: '/ws/events', auth: { type: 'auth', account: true, device: 'p-good' }, ticket: 't-bad' })
    await open(5, 5, keyOpen(), 'BBECAwQFBgcICQoLDA0ODw')
    await until(() => [1, 2, 3, 4, 5].every((id) => closeOf(id)))

    expect(on(1)).toEqual([
      { type: 'auth.failed', channel: 1 },
      { type: 'ws.close', channel: 1, code: CLOSE_ACCESS_DENIED, reason: 'access denied' },
    ])
    expect(on(2)).toEqual([
      { type: 'ws.close', channel: 2, code: CLOSE_DEVICE_NOT_APPROVED, reason: 'device not approved' },
    ])
    expect(on(3)).toEqual([{ type: 'ws.close', channel: 3, code: CLOSE_ACCESS_DENIED, reason: 'access denied' }])
    expect(on(4).map((f) => f.type)).toEqual(['auth.failed', 'ws.close'])
    // The ticket comes from the open record, and an account socket spends it.
    expect(asked.at(-1)).toMatchObject({ key: null, ticket: 't-bad', once: true, device: { path: '/ws/events' } })
    expect(closeOf(5)).toMatchObject({ code: CLOSE_E2E_SESSION_UNKNOWN })
    expect(audit).toEqual([
      { kind: 'refused', reason: 'key_refused' },
      { kind: 'refused', reason: 'device_not_approved' },
      { kind: 'refused', reason: 'ticket_refused' },
    ])

    live.clear()
    await open(6, 6, keyOpen())
    await until(() => Boolean(closeOf(6)))
    expect(closeOf(6)).toMatchObject({ code: CLOSE_E2E_SESSION_UNKNOWN })
    expect(runs).toHaveLength(0)
  })

  test('a bad envelope, a taken channel, a record that does not open, and bad later payloads close with 1008', async () => {
    const { pair, channels, runs, open, closeOf } = await setup()
    channels.receive({ type: 'ws.sealed', channel: 1, data: new Uint8Array(10) })
    const first = await open(2, 7, keyOpen())
    // The same envelope again, on a new tunnel channel: session channel 7 is taken.
    channels.receive({ type: 'ws.sealed', channel: 3, data: first.data })
    const stranger = await testE2ePair()
    const foreign = await sealedSocketEnvelope(stranger.browser, SESSION_ID, 8, keyOpen())
    channels.receive({ type: 'ws.sealed', channel: 4, data: foreign.data })
    // A sealed HTTP request's record kind doesn't open a socket.
    const http = await pair.browser.channel(9)
    const sealedRequest = await http.seal(encodeRequestRecord({ method: 'GET', path: '/api/health', headers: [] }))
    channels.receive({
      type: 'ws.sealed',
      channel: 5,
      data: encodeEnvelope({ sessionId: SESSION_ID, channel: 9, sealed: sealedRequest }),
    })
    await until(() => [1, 3, 4, 5].every((id) => closeOf(id)))
    for (const id of [1, 3, 4, 5]) expect([id, closeOf(id)]).toEqual([id, expect.objectContaining({ code: 1008 })])
    await until(() => runs.length === 1)

    // Later payloads on the open channel: text, a replay, a skipped counter, a tampered record.
    await open(6, 26, keyOpen())
    await until(() => runs.length === 2)
    channels.receive({ type: 'ws.data', channel: 6, data: '{"type":"input","data":"ls"}' })
    const replayed = await open(7, 27, keyOpen())
    await until(() => runs.length === 3)
    const once = await sealMessage(replayed.channel, 'x')
    channels.receive({ type: 'ws.data', channel: 7, data: once })
    channels.receive({ type: 'ws.data', channel: 7, data: once })
    const skipping = await open(8, 28, keyOpen())
    await until(() => runs.length === 4)
    await sealMessage(skipping.channel, 'skipped')
    channels.receive({ type: 'ws.data', channel: 8, data: await sealMessage(skipping.channel, 'y') })
    const tampering = await open(9, 29, keyOpen())
    await until(() => runs.length === 5)
    const tampered = await sealMessage(tampering.channel, 'z')
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1
    channels.receive({ type: 'ws.data', channel: 9, data: tampered })
    await until(() => [6, 7, 8, 9].every((id) => closeOf(id)))
    for (const id of [6, 7, 8, 9]) expect([id, closeOf(id)]).toEqual([id, expect.objectContaining({ code: 1008 })])
    expect(runs.map((run) => run.messages)).toEqual([[], [], ['x'], [], []])
    expect(runs.every((run) => run.closes === (run === runs[0] ? 0 : 1))).toBe(true)
  })
})
