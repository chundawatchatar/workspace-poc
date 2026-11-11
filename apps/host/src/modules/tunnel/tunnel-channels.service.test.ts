import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  auditLine,
  CLOSE_ACCESS_DENIED,
  CLOSE_DEVICE_NOT_APPROVED,
  CLOSE_SESSION_ENDED,
  type MachineFrame,
  relaySocketProtocols,
  WS_CHANNEL_WINDOW_BYTES,
  wsPayloadBytes,
} from '@orch/shared'
import { CAUGHT_UP, deliver, type TermClient } from '@orch/terminal'
import type { Principal } from '../../lib/principal'
import type { SocketConn, SocketData } from '../../lib/socket'
import type { SocketRefusal } from '../../lib/socketRouter'
import { AuditLogRepository, auditLogPath } from '../remote-access/audit-log.repository'
import { type AuditEvent, AuditLogService } from '../remote-access/audit-log.service'
import { fingerprintOf } from '../remote-access/device-proof.service'
import { CHANNEL_QUEUE_CAP_BYTES, type OpenSocket, TunnelChannels } from './tunnel-channels.service'
import { type Authorize, bodySha256, type Credentials, DEVICE_NOT_APPROVED } from './tunnel-http.service'

/** One handler run, as the test sees it. */
interface Opened {
  path: string
  headers: [string, string][]
  principal: Principal
  conn: SocketConn
  messages: SocketData[]
  closes: number
}

let warn: Mock<(...args: unknown[]) => void>
let warnings: string[]

beforeEach(() => {
  asked = []
  warnings = []
  warn = spyOn(console, 'warn').mockImplementation((...args: unknown[]) => void warnings.push(args.join(' ')))
})

/** A temp folder a test made for its audit log. Null means none. */
let auditDir: string | null = null

afterEach(() => {
  warn.mockRestore()
  if (auditDir) rmSync(auditDir, { recursive: true, force: true })
  auditDir = null
})

/** The auth message for `key`, with the device proof `device`. */
const auth = (key: string, device = 'p-good') => JSON.stringify({ type: 'auth', key, device })

/** The auth message that asks to be judged by the ticket the channel opened with, and the device proof `device`. */
const accountAuth = (device = 'p-good') => JSON.stringify({ type: 'auth', account: true, device })

/** The `ws.open` headers of a socket that offered `ticket`, as a browser sends them. */
const withTicket = (ticket: string): [string, string][] => [
  ['sec-websocket-protocol', relaySocketProtocols(ticket).join(', ')],
  ['x-thing', 'a'],
]

/** What `authorize` was asked, in order. */
let asked: Credentials[] = []

/**
 * Accepts the keys `good` (key id `k1`) and `other` (key id `k2`), and the
 * ticket `t-good` as the account `u1`, each with the proof `p-good` of device
 * `d1`. The proof `p-new` stands for a device the machine hasn't approved.
 */
const authorize: Authorize = (credentials) => {
  asked.push(credentials)
  const { key, ticket, device } = credentials
  const known = key === 'good' || key === 'other' || (key === null && ticket === 't-good')
  if (!known) return null
  if (device?.proof === 'p-new') return DEVICE_NOT_APPROVED
  if (device?.proof !== 'p-good') return null
  if (key === 'good') return { kind: 'key', keyId: 'k1', name: 'default', deviceId: 'd1' }
  if (key === 'other') return { kind: 'key', keyId: 'k2', name: 'second', deviceId: 'd1' }
  return { kind: 'account', accountId: 'u1', deviceId: 'd1' }
}

/**
 * Channels whose `openSocket` accepts every path but `/ws/nope`, with the
 * frames they send collected as a fake server would.
 */
function setup(open?: (opened: Opened) => void, authTimeoutMs = 1000, record?: (event: AuditEvent) => void) {
  const frames: MachineFrame[] = []
  const opened: Opened[] = []
  const openSocket: OpenSocket = (path, headers, conn, principal) => {
    if (path === '/ws/nope') return { code: 1008, reason: 'not found' } satisfies SocketRefusal
    const run: Opened = { path, headers, principal, conn, messages: [], closes: 0 }
    opened.push(run)
    open?.(run)
    return { message: (data) => run.messages.push(data), close: () => run.closes++ }
  }
  const channels = new TunnelChannels(openSocket, authorize, (frame) => frames.push(frame), {
    authTimeoutMs,
    record,
  })
  /** Opens `channel` and authorizes it with `key`. */
  const openChannel = (channel: number, key = 'good') => {
    channels.receive({ type: 'ws.open', channel, path: '/ws/events', headers: [] })
    channels.receive({ type: 'ws.data', channel, data: auth(key) })
    const run = opened.at(-1)
    if (!run) throw new Error('not opened')
    return run
  }
  const of = <T extends MachineFrame['type']>(type: T) =>
    frames.filter((f): f is Extract<MachineFrame, { type: T }> => f.type === type)
  return { channels, frames, opened, openChannel, of }
}

const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve))

describe('TunnelChannels', () => {
  test('opens no socket until a valid auth message, and refuses anything else with auth.failed then 4401', async () => {
    const { channels, frames, opened, of } = setup(undefined, 30)
    const firsts: (string | Uint8Array<ArrayBuffer>)[] = [
      new TextEncoder().encode(auth('good')),
      'not json',
      '{"type":"input","data":"ls"}',
      auth('wrong'),
    ]
    for (const [i, data] of firsts.entries()) {
      channels.receive({ type: 'ws.open', channel: i + 1, path: '/ws/events', headers: [] })
      channels.receive({ type: 'ws.data', channel: i + 1, data })
    }
    channels.receive({ type: 'ws.open', channel: 9, path: '/ws/events', headers: [] })
    expect(opened).toHaveLength(0)
    await Bun.sleep(60)
    channels.receive({ type: 'ws.data', channel: 9, data: auth('good') })
    await tick()

    expect(opened).toHaveLength(0)
    for (const channel of [1, 2, 3, 4, 9]) {
      const reason = channel === 9 ? 'auth timeout' : 'access denied'
      expect(frames.filter((f) => 'channel' in f && f.channel === channel)).toEqual([
        { type: 'auth.failed', channel },
        { type: 'ws.close', channel, code: CLOSE_ACCESS_DENIED, reason },
      ])
    }
    expect(of('ws.ack')).toHaveLength(0)
    expect(channels.size).toBe(0)
  })

  test('opens with the principal of a valid key, and a bad path after it gets 1008 without auth.failed', () => {
    const { channels, openChannel, of } = setup()
    const run = openChannel(1, 'other')
    expect(run.principal).toEqual({ kind: 'key', keyId: 'k2', name: 'second', deviceId: 'd1' })
    expect(run.messages).toEqual([])

    channels.receive({ type: 'ws.open', channel: 2, path: '/ws/nope', headers: [] })
    channels.receive({ type: 'ws.data', channel: 2, data: auth('good') })
    expect(of('ws.close')).toEqual([{ type: 'ws.close', channel: 2, code: 1008, reason: 'not found' }])
    expect(of('auth.failed')).toEqual([])
  })

  test('an account auth message is judged by the ticket its socket offered, which it spends, and its device proof; a key message by the key', () => {
    const { channels, frames, opened, of } = setup()
    channels.receive({ type: 'ws.open', channel: 1, path: '/ws/events', headers: withTicket('t-good') })
    channels.receive({ type: 'ws.data', channel: 1, data: accountAuth() })
    expect(opened.map((run) => run.principal)).toEqual([{ kind: 'account', accountId: 'u1', deviceId: 'd1' }])
    const device = { proof: 'p-good', method: 'WS', path: '/ws/events', bodySha256: bodySha256() }
    expect(asked).toEqual([{ key: null, ticket: 't-good', device, once: true }])
    // The subprotocols carried the ticket, so the handler never sees them.
    expect(opened[0]?.headers).toEqual([['x-thing', 'a']])

    // A bad ticket, and no ticket at all.
    channels.receive({ type: 'ws.open', channel: 2, path: '/ws/events', headers: withTicket('t-bad') })
    channels.receive({ type: 'ws.open', channel: 3, path: '/ws/events', headers: [] })
    for (const channel of [2, 3]) channels.receive({ type: 'ws.data', channel, data: accountAuth() })
    expect(opened).toHaveLength(1)
    expect(of('auth.failed')).toEqual([
      { type: 'auth.failed', channel: 2 },
      { type: 'auth.failed', channel: 3 },
    ])
    expect(of('ws.close').map((f) => f.code)).toEqual([CLOSE_ACCESS_DENIED, CLOSE_ACCESS_DENIED])

    // A key auth message on a socket that offered a good ticket is judged by the key, with its proof and no `once`.
    channels.receive({ type: 'ws.open', channel: 4, path: '/ws/events', headers: withTicket('t-good') })
    channels.receive({ type: 'ws.data', channel: 4, data: auth('wrong') })
    expect(opened).toHaveLength(1)
    expect(asked.at(-1)).toEqual({ key: 'wrong', ticket: null, device })
    expect(of('auth.failed').at(-1)).toEqual({ type: 'auth.failed', channel: 4 })

    // A device waiting for approval gets its own close and no `auth.failed`; an account message without a proof,
    // as an older page sends, is refused.
    channels.receive({ type: 'ws.open', channel: 5, path: '/ws/events', headers: withTicket('t-good') })
    channels.receive({ type: 'ws.data', channel: 5, data: accountAuth('p-new') })
    channels.receive({ type: 'ws.open', channel: 6, path: '/ws/events', headers: withTicket('t-good') })
    channels.receive({ type: 'ws.data', channel: 6, data: JSON.stringify({ type: 'auth', account: true }) })
    expect(opened).toHaveLength(1)
    expect(frames.filter((f) => 'channel' in f && f.channel === 5)).toEqual([
      { type: 'ws.close', channel: 5, code: CLOSE_DEVICE_NOT_APPROVED, reason: 'device not approved' },
    ])
    expect(of('auth.failed').at(-1)).toEqual({ type: 'auth.failed', channel: 6 })

    // The same for a key: a waiting device gets its own close, and a key message without a proof is refused.
    channels.receive({ type: 'ws.open', channel: 7, path: '/ws/events', headers: [] })
    channels.receive({ type: 'ws.data', channel: 7, data: auth('good', 'p-new') })
    channels.receive({ type: 'ws.open', channel: 8, path: '/ws/events', headers: [] })
    channels.receive({ type: 'ws.data', channel: 8, data: JSON.stringify({ type: 'auth', key: 'good' }) })
    expect(opened).toHaveLength(1)
    expect(frames.filter((f) => 'channel' in f && f.channel === 7)).toEqual([
      { type: 'ws.close', channel: 7, code: CLOSE_DEVICE_NOT_APPROVED, reason: 'device not approved' },
    ])
    expect(of('auth.failed').at(-1)).toEqual({ type: 'auth.failed', channel: 8 })
    channels.close()
  })

  test('closeChannels closes only the channels it matches, each handler once', () => {
    const { channels, openChannel, opened, of } = setup()
    const a = openChannel(1, 'good')
    const b = openChannel(2, 'other')
    const c = openChannel(3, 'good')
    channels.receive({ type: 'ws.open', channel: 4, path: '/ws/events', headers: [] })
    channels.receive({ type: 'ws.open', channel: 5, path: '/ws/events', headers: withTicket('t-good') })
    channels.receive({ type: 'ws.data', channel: 5, data: accountAuth() })
    const d = opened.at(-1)

    const rotated = (p: Principal) => p.kind === 'key' && p.keyId === 'k1'
    channels.closeChannels(rotated, 'key rotated')
    channels.closeChannels(rotated, 'key rotated')
    expect(d?.closes).toBe(0)
    expect([a.closes, b.closes, c.closes]).toEqual([1, 0, 1])
    expect(of('ws.close')).toEqual([
      { type: 'ws.close', channel: 1, code: CLOSE_ACCESS_DENIED, reason: 'key rotated' },
      { type: 'ws.close', channel: 3, code: CLOSE_ACCESS_DENIED, reason: 'key rotated' },
    ])
    expect(channels.size).toBe(3)

    channels.closeChannels((p) => p.kind === 'account', 'account unlinked')
    expect([b.closes, d?.closes]).toEqual([0, 1])
    expect(of('ws.close').at(-1)).toEqual({
      type: 'ws.close',
      channel: 5,
      code: CLOSE_ACCESS_DENIED,
      reason: 'account unlinked',
    })

    // A caller may choose the code, as a session that ended on the server does.
    channels.closeChannels((p) => p.kind === 'key', 'session ended', CLOSE_SESSION_ENDED)
    expect(b.closes).toBe(1)
    expect(of('ws.close').at(-1)).toEqual({
      type: 'ws.close',
      channel: 2,
      code: CLOSE_SESSION_ENDED,
      reason: 'session ended',
    })
    channels.close()
  })

  test('delivers messages in order and acks exactly the payload bytes, ignoring frames for unknown channels', async () => {
    const { channels, openChannel, of, opened } = setup()
    const run = openChannel(1)
    const payloads: (string | Uint8Array<ArrayBuffer>)[] = ['{"type":"focus"}', 'héllo ✓', new Uint8Array([1, 2, 3])]
    for (const data of payloads) channels.receive({ type: 'ws.data', channel: 1, data })
    await tick()
    channels.receive({ type: 'ws.data', channel: 1, data: 'later' })
    await tick()

    expect(run.messages).toEqual([...payloads, 'later'])
    const acks = of('ws.ack')
    expect(acks.length).toBe(2)
    // The auth message is acked too, though the handler never sees it.
    const total = [auth('good'), ...payloads, 'later'].reduce((sum, data) => sum + wsPayloadBytes(data), 0)
    expect(acks.reduce((sum, ack) => sum + ack.bytes, 0)).toBe(total)

    channels.receive({ type: 'ws.data', channel: 9, data: 'x' })
    channels.receive({ type: 'ws.ack', channel: 9, bytes: 5 })
    channels.receive({ type: 'ws.close', channel: 9 })
    channels.receive({ type: 'ws.open', channel: 1, path: '/ws/events', headers: [] })
    await tick()
    expect(opened).toHaveLength(1)
    expect(of('ws.ack')).toHaveLength(2)
  })

  test('sends within the window, queues the rest in order, and follows the acks', () => {
    const { channels, openChannel, of } = setup()
    const { conn } = openChannel(1)
    const big = 'x'.repeat(WS_CHANNEL_WINDOW_BYTES - 10)
    // Under the window a message may start even when it then runs over.
    expect(conn.send(big)).toBe(big.length)
    expect(conn.send('0123456789ab')).toBe(12)
    expect(conn.send('queued-1')).toBe(-1)
    expect(conn.send(new Uint8Array(4))).toBe(-1)
    expect(conn.buffered()).toBe(big.length + 12 + 8 + 4)
    expect(of('ws.data')).toHaveLength(2)

    channels.receive({ type: 'ws.ack', channel: 1, bytes: big.length })
    const data = of('ws.data').map((f) => f.data)
    expect(data.slice(2)).toEqual(['queued-1', new Uint8Array(4)])
    expect(conn.buffered()).toBe(12 + 8 + 4)
  })

  test('marks a terminal stale while acks are held back, and lets it resync once they arrive', () => {
    let client: TermClient | undefined
    const { channels, openChannel, of } = setup(({ conn }) => {
      client = {
        ready: true,
        queue: [],
        queued: 0,
        stale: false,
        want: null,
        answers: false,
        send: (data) => conn.send(data),
        buffered: () => conn.buffered(),
      }
    })
    openChannel(1)
    if (!client) throw new Error('no client')
    const chunk = new Uint8Array(32 * 1024)
    for (let i = 0; i < 40 && !client.stale; i++) deliver(client, chunk)
    expect(client.stale).toBe(true)
    expect(client.buffered()).toBeGreaterThan(1024 * 1024)

    // The fake server now acks all it has been sent, as the browser takes it.
    let acked = 0
    while (client.buffered() >= CAUGHT_UP) {
      const sent = of('ws.data').reduce((sum, f) => sum + wsPayloadBytes(f.data), 0)
      if (sent === acked) throw new Error('the queue stopped moving')
      channels.receive({ type: 'ws.ack', channel: 1, bytes: sent - acked })
      acked = sent
    }
    expect(client.buffered()).toBeLessThan(CAUGHT_UP)
  })

  test('closes a channel whose queue passes the cap with 1011, and one with an oversized message with 1009', () => {
    const { channels, openChannel, of } = setup()
    const slow = openChannel(1)
    const chunk = 'y'.repeat(256 * 1024)
    const results: number[] = []
    const queued = CHANNEL_QUEUE_CAP_BYTES / chunk.length
    for (let i = 0; i < queued + 2; i++) results.push(slow.conn.send(chunk))
    // One goes out within the window, the queue fills to the cap, and the next message closes the channel.
    expect(results).toEqual([chunk.length, ...Array(queued).fill(-1), 0])
    expect(slow.closes).toBe(1)
    expect(of('ws.close')).toEqual([{ type: 'ws.close', channel: 1, code: 1011, reason: 'too far behind' }])
    expect(slow.conn.send('more')).toBe(0)

    const big = openChannel(2)
    const secret = 'z'.repeat(2 * 1024 * 1024)
    expect(big.conn.send(secret)).toBe(0)
    expect(big.closes).toBe(1)
    expect(of('ws.close')[1]).toEqual({ type: 'ws.close', channel: 2, code: 1009, reason: 'message too big' })
    expect(warnings.some((line) => line.includes('does not fit'))).toBe(true)
    expect(warnings.join('\n')).not.toContain('zzzz')
    expect(channels.size).toBe(0)
  })

  test('ends a channel the server closes, and every channel when the tunnel goes, sending nothing', () => {
    const { channels, openChannel, frames } = setup()
    const a = openChannel(1)
    const b = openChannel(2)
    const c = openChannel(3)
    a.conn.send('x'.repeat(WS_CHANNEL_WINDOW_BYTES))
    a.conn.send('queued')
    const before = frames.length

    channels.receive({ type: 'ws.close', channel: 1, code: 1000 })
    channels.receive({ type: 'ws.ack', channel: 1, bytes: WS_CHANNEL_WINDOW_BYTES })
    channels.close()
    channels.close()
    b.conn.close(1000)
    expect(c.conn.send('late')).toBe(0)
    channels.receive({ type: 'ws.open', channel: 4, path: '/ws/events', headers: [] })

    expect([a.closes, b.closes, c.closes]).toEqual([1, 1, 1])
    expect(frames.length).toBe(before)
    expect(channels.size).toBe(0)
  })

  test('records each socket opened and closed, however it ends, and each refusal with its reason', async () => {
    auditDir = mkdtempSync(join(tmpdir(), 'orch-channels-audit-'))
    const file = auditLogPath(auditDir)
    const audit = new AuditLogService(new AuditLogRepository(file))
    const { channels, opened, openChannel } = setup(undefined, 30, (event) => audit.record(event))
    const lines = () =>
      readFileSync(file, 'utf8')
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line))

    openChannel(1)
    channels.receive({ type: 'ws.close', channel: 1, code: 1000 })
    channels.receive({ type: 'ws.open', channel: 2, path: '/ws/events', headers: withTicket('t-good') })
    channels.receive({ type: 'ws.data', channel: 2, data: accountAuth() })
    channels.closeChannels((principal) => principal.kind === 'account', 'device revoked')
    openChannel(3).conn.close(1000)
    channels.receive({ type: 'ws.open', channel: 4, path: '/ws/nope', headers: [] })
    channels.receive({ type: 'ws.data', channel: 4, data: auth('good') })
    channels.receive({ type: 'ws.open', channel: 5, path: '/ws/events', headers: [] })
    channels.receive({ type: 'ws.data', channel: 5, data: 'not json' })
    channels.receive({ type: 'ws.open', channel: 6, path: '/ws/events', headers: [] })
    channels.receive({ type: 'ws.data', channel: 6, data: auth('wrong') })
    channels.receive({ type: 'ws.open', channel: 7, path: '/ws/events', headers: [] })
    channels.receive({ type: 'ws.data', channel: 7, data: auth('good', 'p-new') })
    channels.receive({ type: 'ws.open', channel: 8, path: '/ws/events', headers: [] })
    await Bun.sleep(60)
    openChannel(9)
    channels.close()

    expect(opened).toHaveLength(4)
    const written = lines()
    for (const line of written) expect(auditLine.safeParse(line).success).toBe(true)
    const fingerprint = fingerprintOf('d1')
    const sessions = written.filter((line) => line.kind === 'opened').map((line) => line.session)
    expect(new Set(sessions).size).toBe(5)
    const [key, account, hostClosed, refusedByHandler, dropped] = sessions
    expect(written.map(({ at: _, ...line }) => line)).toEqual([
      { kind: 'opened', session: key, principal: 'key', keyId: 'k1', fingerprint },
      { kind: 'closed', session: key },
      { kind: 'opened', session: account, principal: 'account', accountId: 'u1', fingerprint },
      { kind: 'closed', session: account },
      { kind: 'opened', session: hostClosed, principal: 'key', keyId: 'k1', fingerprint },
      { kind: 'closed', session: hostClosed },
      { kind: 'opened', session: refusedByHandler, principal: 'key', keyId: 'k1', fingerprint },
      { kind: 'closed', session: refusedByHandler },
      { kind: 'refused', reason: 'no_auth' },
      // This stub gives no reasons, so the channel falls back to the credential it was given.
      { kind: 'refused', reason: 'key_refused' },
      { kind: 'refused', reason: 'device_not_approved' },
      { kind: 'refused', reason: 'no_auth' },
      { kind: 'opened', session: dropped, principal: 'key', keyId: 'k1', fingerprint },
      { kind: 'closed', session: dropped },
    ])
  })
})
