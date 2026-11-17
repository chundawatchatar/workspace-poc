import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  auditLine,
  auditLogResponse,
  DEVICE_PROOF_HEADER,
  RELAY_TICKET_HEADER,
  relaySocketProtocols,
  routes,
} from '@orch/shared'
import {
  ACCOUNT_ID,
  auditFile,
  type BrowserSession,
  type Conn,
  conns,
  device,
  key,
  keyHeaders,
  local,
  machineId,
  openE2eSession,
  relay,
  remoteAccess,
  sealedSocket,
  send,
  stub,
  until,
  useTunnelHarness,
  welcomed,
} from './app.tunnel.testing'
import { fingerprintOf } from './modules/remote-access/device-proof.service'
import { testDevice } from './modules/remote-access/device-proof.testing'

// The remote access audit log end to end, on the harness in
// `app.tunnel.testing.ts`: what each tunneled socket and refusal writes to
// `remote-audit.jsonl`, and that nothing secret ever does.
useTunnelHarness()

const TERM = '/ws/term/t1'
const HEALTH = routes.system.health.path
const MACHINE_KEY = routes.system.machineKey.path
const TYPED = 'echo typed-into-the-terminal'

/** Every line of the audit log, parsed. */
const lines = () =>
  readFileSync(auditFile(), 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line))

/** The nonce a device proof carries, read from its payload. */
const nonceOf = (proof: string) => JSON.parse(Buffer.from(proof.split('.')[1] ?? '', 'base64url').toString()).nonce

describe('remote access audit log', () => {
  test('records sockets opened and closed and every refusal, with no secret, path or header in the file', async () => {
    let conn: Conn = await welcomed()
    const stranger = await testDevice()
    const secrets: string[] = []
    const closes = () => conn.frames.filter((f) => f.type === 'ws.close')
    const answered = (id: number) => conn.frames.some((f) => f.type === 'http.response' && f.id === id)
    const keep = <T extends string>(value: T) => {
      secrets.push(value)
      return value
    }
    const proof = async (who: typeof device, method: string, path: string, now?: number) => {
      const signed = keep(await who.proof({ machineId, method, path }, now))
      secrets.push(nonceOf(signed))
      return signed
    }
    const ticket = (overrides: { exp?: number } = {}) =>
      keep(relay.ticket({ sub: ACCOUNT_ID, aud: machineId, ...overrides }))
    // The key bootstrap, one of the two requests still served unsealed, so it is still authorized.
    const request = (id: number, headers: [string, string][]) =>
      send(conn, { type: 'http.request', id, method: 'GET', path: MACHINE_KEY, headers })
    const keySocket = (e2e: BrowserSession, channel: number) => sealedSocket(conn, e2e, channel, TERM)
    const accountSocket = (e2e: BrowserSession, channel: number, offered: string) =>
      sealedSocket(conn, e2e, channel, TERM, { as: { ticket: offered } })
    keep(key)

    // A revoked device waits once more, and is approved again.
    remoteAccess.removeDevice(device.id)
    request(9, [
      [RELAY_TICKET_HEADER, ticket()],
      [DEVICE_PROOF_HEADER, await proof(device, 'GET', MACHINE_KEY)],
    ])
    await until(() => answered(9))
    remoteAccess.approveDevice(fingerprintOf(device.id))

    // A key socket that the browser closes, after typing into the terminal.
    const keySession = await openE2eSession(conn, 20)
    const typing = await keySocket(keySession, 1)
    await until(() => stub.attached.size === 1)
    await typing.send(JSON.stringify({ type: 'input', data: TYPED }))
    await until(() => stub.inputs.includes(TYPED))
    send(conn, { type: 'ws.close', channel: 1, code: 1000 })
    await until(() => stub.attached.size === 0)

    // An account socket that ends with its session, then one whose ticket is offered again on a new session.
    const reused = ticket()
    await accountSocket(await openE2eSession(conn, 21, { ticket: ticket() }), 2, reused)
    await until(() => stub.attached.size === 1)
    send(conn, { type: 'session.ended', accountId: ACCOUNT_ID })
    await until(() => stub.attached.size === 0)
    const accountSession = await openE2eSession(conn, 22, { ticket: ticket() })
    await accountSocket(accountSession, 3, reused)
    await until(() => closes().length === 2)
    // A plain socket and a plain request, with a valid ticket and key, refused before either is read.
    send(conn, {
      type: 'ws.open',
      channel: 4,
      path: TERM,
      headers: [['sec-websocket-protocol', relaySocketProtocols(ticket()).join(', ')]],
    })
    send(conn, { type: 'ws.data', channel: 4, data: TYPED })
    send(conn, {
      type: 'http.request',
      id: 17,
      method: 'GET',
      path: HEALTH,
      headers: await keyHeaders(key, 'GET', HEALTH),
    })
    await until(() => closes().length === 3 && answered(17))

    // Refused requests: a wrong key, a forged and an expired ticket, a stale and a replayed proof, an unapproved device.
    request(10, await keyHeaders(keep(`${key.slice(0, -1)}x`), 'GET', MACHINE_KEY))
    request(11, [
      [RELAY_TICKET_HEADER, keep(`${ticket().slice(0, -2)}xx`)],
      [DEVICE_PROOF_HEADER, await proof(device, 'GET', MACHINE_KEY)],
    ])
    request(12, [
      [RELAY_TICKET_HEADER, ticket({ exp: Math.floor(Date.now() / 1000) - 60 })],
      [DEVICE_PROOF_HEADER, await proof(device, 'GET', MACHINE_KEY)],
    ])
    request(13, [
      [RELAY_TICKET_HEADER, ticket()],
      [DEVICE_PROOF_HEADER, await proof(device, 'GET', MACHINE_KEY, Date.now() - 10 * 60_000)],
    ])
    const once = await proof(device, 'GET', MACHINE_KEY)
    request(14, [
      [RELAY_TICKET_HEADER, ticket()],
      [DEVICE_PROOF_HEADER, once],
    ])
    await until(() => answered(14))
    request(15, [
      [RELAY_TICKET_HEADER, ticket()],
      [DEVICE_PROOF_HEADER, once],
    ])
    request(16, [
      [RELAY_TICKET_HEADER, ticket()],
      [DEVICE_PROOF_HEADER, await proof(stranger, 'GET', MACHINE_KEY)],
    ])
    await until(() => [10, 11, 12, 13, 15, 16].every(answered))

    // A key socket that the tunnel drops, then one closed by revoking its device.
    await keySocket(keySession, 5)
    await until(() => stub.attached.size === 1)
    conn.ws.close(1000)
    await until(() => stub.attached.size === 0 && conns.length === 2)
    await until(() => conns[1]?.frames.some((f) => f.type === 'hello') ?? false)
    conn = conns[1] as Conn
    await Bun.sleep(5)
    // The tunnel came back, and the end-to-end sessions outlived it.
    await accountSocket(accountSession, 6, ticket())
    await until(() => stub.attached.size === 1)
    remoteAccess.removeDevice(device.id)
    await until(() => stub.attached.size === 0)

    const written = lines()
    for (const line of written) expect(auditLine.safeParse(line).success).toBe(true)
    const fingerprint = fingerprintOf(device.id)
    const sessions = written.filter((line) => line.kind === 'opened').map((line) => line.session)
    const [keyClosed, ended, dropped, revoked] = sessions
    for (const { at } of written) expect(Date.parse(at)).toBeGreaterThan(0)
    expect(written.map(({ at: _, ...line }) => line)).toEqual([
      { kind: 'refused', reason: 'device_not_approved', principal: 'account', fingerprint },
      { kind: 'opened', session: keyClosed, principal: 'key', keyId: expect.any(String), fingerprint },
      { kind: 'closed', session: keyClosed },
      { kind: 'opened', session: ended, principal: 'account', accountId: ACCOUNT_ID, fingerprint },
      { kind: 'closed', session: ended },
      { kind: 'refused', reason: 'ticket_reused', principal: 'account', fingerprint },
      { kind: 'refused', reason: 'unsealed' },
      { kind: 'refused', reason: 'unsealed' },
      { kind: 'refused', reason: 'key_refused' },
      { kind: 'refused', reason: 'ticket_refused' },
      { kind: 'refused', reason: 'ticket_refused' },
      { kind: 'refused', reason: 'proof_refused' },
      { kind: 'refused', reason: 'proof_refused' },
      { kind: 'refused', reason: 'device_not_approved', principal: 'account', fingerprint: fingerprintOf(stranger.id) },
      { kind: 'opened', session: dropped, principal: 'key', keyId: expect.any(String), fingerprint },
      { kind: 'closed', session: dropped },
      { kind: 'opened', session: revoked, principal: 'account', accountId: ACCOUNT_ID, fingerprint },
      { kind: 'closed', session: revoked },
    ])
    expect(new Set(sessions).size).toBe(4)

    const text = readFileSync(auditFile(), 'utf8')
    const hidden = [
      ...secrets,
      device.id,
      stranger.id,
      ...[device, stranger].flatMap(({ publicKey }) => [publicKey.x, publicKey.y]),
      TERM,
      HEALTH,
      MACHINE_KEY,
      RELAY_TICKET_HEADER,
      DEVICE_PROOF_HEADER,
      'typed-into-the-terminal',
      'default',
    ]
    for (const value of hidden) expect(text).not.toContain(value)

    // The owner reads the same history locally, merged and newest first.
    const answer = await fetch(`http://127.0.0.1:${local.port}${routes.remoteAccess.auditLog.path}`)
    const { entries } = auditLogResponse.parse(await answer.json())
    expect(entries).toHaveLength(14)
    expect(entries[0]).toMatchObject({ kind: 'session', session: revoked, closedAt: expect.any(String) })
    expect(entries.at(-2)).toMatchObject({ kind: 'session', session: keyClosed, principal: 'key' })
  })
})
