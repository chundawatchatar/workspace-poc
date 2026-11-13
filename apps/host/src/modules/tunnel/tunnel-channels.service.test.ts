import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  auditLine,
  CLOSE_ACCESS_DENIED,
  CLOSE_SESSION_ENDED,
  type E2eSession,
  type E2eSocketOpen,
  type MachineFrame,
  relaySocketProtocols,
  wsPayloadBytes,
} from '@orch/shared'
import { CAUGHT_UP, deliver, type TermClient } from '@orch/terminal'
import type { Principal } from '../../lib/principal'
import type { SocketConn, SocketData } from '../../lib/socket'
import type { SocketRefusal } from '../../lib/socketRouter'
import { AuditLogRepository, auditLogPath } from '../remote-access/audit-log.repository'
import { type AuditEvent, AuditLogService } from '../remote-access/audit-log.service'
import { fingerprintOf } from '../remote-access/device-proof.service'
import { openMessages, sealedSocketEnvelope, sealMessage, testE2ePair } from './tunnel.testing'
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

/** What `authorize` was asked, in order. */
let asked: Credentials[] = []

const keyK1: Principal = { kind: 'key', keyId: 'k1', name: 'default', deviceId: 'd1' }
const keyK2: Principal = { kind: 'key', keyId: 'k2', name: 'second', deviceId: 'd1' }
const account: Principal = { kind: 'account', accountId: 'u1', deviceId: 'd1', ticketExp: 0 }

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
  if (key === 'good') return keyK1
  if (key === 'other') return keyK2
  return account
}

/** Who a sealed socket comes as; each has its own live session. */
type As = 'good' | 'other' | 'account'
const OWNERS: Record<As, Principal> = { good: keyK1, other: keyK2, account }

/** The open record a browser seals for `as` on `path`. */
function openRecord(as: As, path = '/ws/events', device = 'p-good'): E2eSocketOpen {
  if (as === 'account') return { path, auth: { type: 'auth', account: true, device }, ticket: 't-good' }
  return { path, auth: { type: 'auth', key: as, device } }
}

async function until(check: () => boolean, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await Bun.sleep(2)
  }
}

/**
 * Channels with one live session for each of `OWNERS`, whose `openSocket`
 * accepts every path but `/ws/nope` and answers `ping` with `pong`, with the
 * frames they send collected as a fake server would.
 */
async function setup(
  options: { open?: (opened: Opened) => void; now?: () => number; record?: (event: AuditEvent) => void } = {},
) {
  const frames: MachineFrame[] = []
  const opened: Opened[] = []
  const live = new Map<string, { principal: Principal; session: E2eSession }>()
  const browsers = new Map<As, { sessionId: string; browser: E2eSession }>()
  for (const as of ['good', 'other', 'account'] as const) {
    const pair = await testE2ePair()
    const sessionId = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url')
    live.set(sessionId, { principal: OWNERS[as], session: pair.machine })
    browsers.set(as, { sessionId, browser: pair.browser })
  }
  const openSocket: OpenSocket = (path, headers, conn, principal) => {
    if (path === '/ws/nope') return { code: 1008, reason: 'not found' } satisfies SocketRefusal
    const run: Opened = { path, headers, principal, conn, messages: [], closes: 0 }
    opened.push(run)
    options.open?.(run)
    return {
      message: (data) => {
        run.messages.push(data)
        if (data === 'ping') conn.send('pong')
      },
      close: () => run.closes++,
    }
  }
  const channels = new TunnelChannels(openSocket, authorize, (frame) => frames.push(frame), {
    now: options.now,
    record: options.record,
    sessions: (id) => live.get(id) ?? null,
  })
  /** Sends `record` sealed on the session of `as`, as tunnel channel `id`; returns the browser's end. */
  const sealedOpen = async (id: number, as: As, record: E2eSocketOpen) => {
    const { sessionId, browser } = browsers.get(as) as { sessionId: string; browser: E2eSession }
    const { channel, data } = await sealedSocketEnvelope(browser, sessionId, id, record)
    channels.receive({ type: 'ws.sealed', channel: id, data })
    return channel
  }
  /** Opens `id` as `as` and waits for its handler. */
  const openChannel = async (id: number, as: As = 'good') => {
    const before = opened.length
    const e2e = await sealedOpen(id, as, openRecord(as))
    await until(() => opened.length > before)
    return { run: opened.at(-1) as Opened, e2e }
  }
  const on = (id: number) => frames.filter((f) => 'channel' in f && f.channel === id)
  const closeOf = (id: number) => on(id).find((f) => f.type === 'ws.close')
  const of = <T extends MachineFrame['type']>(type: T) =>
    frames.filter((f): f is Extract<MachineFrame, { type: T }> => f.type === type)
  return { channels, frames, opened, sealedOpen, openChannel, on, closeOf, of }
}

describe('TunnelChannels', () => {
  test('refuses every plain ws.open as it arrives, before any credential, while a sealed socket opens and echoes', async () => {
    const audit: AuditEvent[] = []
    const { channels, frames, opened, openChannel, on, of } = await setup({ record: (event) => audit.push(event) })
    const headers: [string, string][] = [['sec-websocket-protocol', relaySocketProtocols('t-good').join(', ')]]
    channels.receive({ type: 'ws.open', channel: 1, path: '/ws/events', headers: [] })
    channels.receive({ type: 'ws.open', channel: 2, path: '/ws/term/t1?cols=80', headers })
    channels.receive({ type: 'ws.data', channel: 1, data: JSON.stringify({ type: 'auth', key: 'good', device: 'p' }) })
    channels.receive({
      type: 'ws.data',
      channel: 2,
      data: JSON.stringify({ type: 'auth', account: true, device: 'p' }),
    })
    await Bun.sleep(5)

    const reason = 'end-to-end encryption required'
    expect(frames).toEqual([
      { type: 'ws.close', channel: 1, code: CLOSE_ACCESS_DENIED, reason },
      { type: 'ws.close', channel: 2, code: CLOSE_ACCESS_DENIED, reason },
    ])
    expect(audit).toEqual([
      { kind: 'refused', reason: 'unsealed' },
      { kind: 'refused', reason: 'unsealed' },
    ])
    expect([asked, opened, channels.list(), channels.size]).toEqual([[], [], [], 0])

    const { run, e2e } = await openChannel(3)
    channels.receive({ type: 'ws.data', channel: 3, data: await sealMessage(e2e, 'ping') })
    await until(() => on(3).some((f) => f.type === 'ws.data'))
    expect(run.messages).toEqual(['ping'])
    const payloads = on(3).flatMap((f) => (f.type === 'ws.data' ? [f.data] : []))
    expect(await openMessages(e2e, payloads)).toEqual(['pong'])

    // A plain open for a live channel, and frames for unknown channels, are ignored.
    const before = frames.length
    channels.receive({ type: 'ws.open', channel: 3, path: '/ws/events', headers: [] })
    channels.receive({ type: 'ws.data', channel: 9, data: 'x' })
    channels.receive({ type: 'ws.ack', channel: 9, bytes: 5 })
    channels.receive({ type: 'ws.close', channel: 9 })
    await Bun.sleep(5)
    expect(frames.slice(before).filter((f) => f.type !== 'ws.ack')).toEqual([])
    expect(of('ws.ack').every((f) => f.channel === 3)).toBe(true)
    expect(channels.size).toBe(1)
    expect(audit.filter((e) => e.kind === 'refused')).toHaveLength(2)
    channels.close()
  })

  test('judges a sealed socket by its key, or by the ticket sealed with it, which it spends, with its proof', async () => {
    const { sealedOpen, openChannel, on, closeOf, opened } = await setup()
    const device = { proof: 'p-good', method: 'WS', path: '/ws/events', bodySha256: bodySha256() }
    expect((await openChannel(1, 'other')).run.principal).toEqual(keyK2)
    expect(asked.at(-1)).toEqual({ key: 'other', ticket: null, device })
    expect((await openChannel(2, 'account')).run.principal).toEqual(account)
    expect(asked.at(-1)).toEqual({ key: null, ticket: 't-good', device, once: true })

    // With a key the key decides, even when the ticket beside it would pass.
    await sealedOpen(3, 'account', { ...openRecord('account'), auth: { type: 'auth', key: 'wrong', device: 'p-good' } })
    // A handler that refuses the path closes without `auth.failed`.
    await sealedOpen(4, 'good', openRecord('good', '/ws/nope'))
    await until(() => Boolean(closeOf(3) && closeOf(4)))
    expect(asked.at(-2)).toEqual({ key: 'wrong', ticket: null, device })
    expect(on(3)).toEqual([
      { type: 'auth.failed', channel: 3 },
      { type: 'ws.close', channel: 3, code: CLOSE_ACCESS_DENIED, reason: 'access denied' },
    ])
    expect(on(4)).toEqual([{ type: 'ws.close', channel: 4, code: 1008, reason: 'not found' }])
    expect(opened).toHaveLength(2)
  })

  test('closeChannels closes only the channels it matches, each handler once', async () => {
    const { channels, openChannel, of } = await setup()
    const a = (await openChannel(1, 'good')).run
    const b = (await openChannel(2, 'other')).run
    const c = (await openChannel(3, 'good')).run
    const d = (await openChannel(5, 'account')).run

    const rotated = (p: Principal) => p.kind === 'key' && p.keyId === 'k1'
    channels.closeChannels(rotated, 'key rotated')
    channels.closeChannels(rotated, 'key rotated')
    expect([a.closes, b.closes, c.closes, d.closes]).toEqual([1, 0, 1, 0])
    expect(of('ws.close')).toEqual([
      { type: 'ws.close', channel: 1, code: CLOSE_ACCESS_DENIED, reason: 'key rotated' },
      { type: 'ws.close', channel: 3, code: CLOSE_ACCESS_DENIED, reason: 'key rotated' },
    ])
    expect(channels.size).toBe(2)

    channels.closeChannels((p) => p.kind === 'account', 'account unlinked')
    expect([b.closes, d.closes]).toEqual([0, 1])
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

  test('list shows only open, authorized channels, each with its principal and when its auth was accepted', async () => {
    let clock = 1000
    const { channels, openChannel } = await setup({ now: () => clock })
    await openChannel(1, 'good')
    clock = 3000
    await openChannel(2, 'account')
    await openChannel(4, 'other')
    channels.receive({ type: 'ws.close', channel: 4 })

    expect(channels.list()).toEqual([
      { principal: keyK1, openedAt: 1000 },
      { principal: account, openedAt: 3000 },
    ])
    channels.close()
    expect(channels.list()).toEqual([])
  })

  test('marks a terminal stale while acks are held back, and lets it resync once they arrive', async () => {
    let client: TermClient | undefined
    const { channels, openChannel, of } = await setup({
      open: ({ conn }) => {
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
      },
    })
    await openChannel(1)
    if (!client) throw new Error('no client')
    const term = client
    const chunk = new Uint8Array(32 * 1024)
    for (let i = 0; i < 40 && !term.stale; i++) deliver(term, chunk)
    expect(term.stale).toBe(true)
    expect(term.buffered()).toBeGreaterThan(1024 * 1024)

    // The fake server now acks all it has been sent, as the browser takes it.
    const sent = () => of('ws.data').reduce((sum, f) => sum + wsPayloadBytes(f.data), 0)
    let acked = 0
    while (term.buffered() >= CAUGHT_UP) {
      await until(() => sent() > acked)
      const total = sent()
      channels.receive({ type: 'ws.ack', channel: 1, bytes: total - acked })
      acked = total
    }
    expect(term.buffered()).toBeLessThan(CAUGHT_UP)
  })

  test('closes a channel whose queue passes the cap with 1011, and one with an oversized message with 1009', async () => {
    const { channels, openChannel, of } = await setup()
    const slow = (await openChannel(1)).run
    const chunk = 'y'.repeat(256 * 1024)
    const sealed = chunk.length + 25
    const results: number[] = []
    for (let i = 0; i < 20 && results.at(-1) !== 0; i++) results.push(slow.conn.send(chunk))
    // One goes out within the window; the rest, counted while still being sealed, queue up to the cap.
    const queued = Math.floor(CHANNEL_QUEUE_CAP_BYTES / sealed) - 1
    expect(results).toEqual([sealed, ...Array(queued).fill(-1), 0])
    expect(slow.closes).toBe(1)
    expect(of('ws.close')).toEqual([{ type: 'ws.close', channel: 1, code: 1011, reason: 'too far behind' }])
    expect(slow.conn.send('more')).toBe(0)

    const big = (await openChannel(2)).run
    const secret = 'z'.repeat(2 * 1024 * 1024)
    expect(big.conn.send(secret)).toBe(0)
    expect(big.closes).toBe(1)
    expect(of('ws.close')[1]).toEqual({ type: 'ws.close', channel: 2, code: 1009, reason: 'message too big' })
    expect(warnings.some((line) => line.includes('does not fit'))).toBe(true)
    expect(warnings.join('\n')).not.toContain('zzzz')
    expect(channels.size).toBe(0)
  })

  test('ends a channel the server closes, and every channel when the tunnel goes, sending nothing', async () => {
    const { channels, openChannel, frames } = await setup()
    const a = (await openChannel(1)).run
    const b = (await openChannel(2)).run
    const c = (await openChannel(3)).run
    a.conn.send('x'.repeat(256 * 1024))
    a.conn.send('queued')
    await Bun.sleep(10)
    const before = frames.length

    channels.receive({ type: 'ws.close', channel: 1, code: 1000 })
    channels.receive({ type: 'ws.ack', channel: 1, bytes: 512 * 1024 })
    channels.close()
    channels.close()
    b.conn.close(1000)
    expect(c.conn.send('late')).toBe(0)
    channels.receive({ type: 'ws.open', channel: 4, path: '/ws/events', headers: [] })

    expect([a.closes, b.closes, c.closes]).toEqual([1, 1, 1])
    expect(frames.length).toBe(before)
    expect(channels.size).toBe(0)
  })

  test('records each socket opened and closed, however it ends, and each refusal with its reason alone', async () => {
    auditDir = mkdtempSync(join(tmpdir(), 'orch-channels-audit-'))
    const file = auditLogPath(auditDir)
    const audit = new AuditLogService(new AuditLogRepository(file))
    const { channels, opened, openChannel, sealedOpen, closeOf } = await setup({
      record: (event) => audit.record(event),
    })
    const lines = () =>
      readFileSync(file, 'utf8')
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line))

    await openChannel(1)
    channels.receive({ type: 'ws.close', channel: 1, code: 1000 })
    await openChannel(2, 'account')
    channels.closeChannels((principal) => principal.kind === 'account', 'device revoked')
    ;(await openChannel(3)).run.conn.close(1000)
    await sealedOpen(4, 'good', openRecord('good', '/ws/nope'))
    await until(() => Boolean(closeOf(4)))
    await sealedOpen(5, 'good', { path: '/ws/events', auth: { type: 'auth', key: 'wrong', device: 'p-good' } })
    await until(() => Boolean(closeOf(5)))
    await sealedOpen(6, 'good', openRecord('good', '/ws/events', 'p-new'))
    await until(() => Boolean(closeOf(6)))
    channels.receive({ type: 'ws.open', channel: 7, path: '/ws/events?key=secret', headers: [['x-orch-key', 'k']] })
    await openChannel(8)
    channels.close()

    expect(opened).toHaveLength(4)
    const written = lines()
    for (const line of written) expect(auditLine.safeParse(line).success).toBe(true)
    const fingerprint = fingerprintOf('d1')
    const sessions = written.filter((line) => line.kind === 'opened').map((line) => line.session)
    expect(new Set(sessions).size).toBe(5)
    const [key, accountSession, hostClosed, refusedByHandler, dropped] = sessions
    expect(written.map(({ at: _, ...line }) => line)).toEqual([
      { kind: 'opened', session: key, principal: 'key', keyId: 'k1', fingerprint },
      { kind: 'closed', session: key },
      { kind: 'opened', session: accountSession, principal: 'account', accountId: 'u1', fingerprint },
      { kind: 'closed', session: accountSession },
      { kind: 'opened', session: hostClosed, principal: 'key', keyId: 'k1', fingerprint },
      { kind: 'closed', session: hostClosed },
      { kind: 'opened', session: refusedByHandler, principal: 'key', keyId: 'k1', fingerprint },
      { kind: 'closed', session: refusedByHandler },
      // This stub gives no reasons, so the channel falls back to the credential it was given.
      { kind: 'refused', reason: 'key_refused' },
      { kind: 'refused', reason: 'device_not_approved' },
      { kind: 'refused', reason: 'unsealed' },
      { kind: 'opened', session: dropped, principal: 'key', keyId: 'k1', fingerprint },
      { kind: 'closed', session: dropped },
    ])
    // An unsealed refusal holds its kind, reason and time, and nothing about the socket.
    expect(Object.keys(written.find((line) => line.reason === 'unsealed')).sort()).toEqual(['at', 'kind', 'reason'])
  })
})
