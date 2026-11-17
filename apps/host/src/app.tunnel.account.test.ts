import { describe, expect, test } from 'bun:test'
import { CLOSE_ACCESS_DENIED, DEVICE_NOT_APPROVED_CODE, routes } from '@orch/shared'
import {
  ACCOUNT_ID,
  accountTicket,
  type Conn,
  credentialHeaders,
  keys,
  local,
  openE2eSession,
  remoteAccess,
  sealedRequest,
  sealedSocket,
  send,
  stub,
  until,
  useTunnelHarness,
  welcomed,
} from './app.tunnel.testing'
import { fingerprintOf } from './modules/remote-access/device-proof.service'
import { testDevice } from './modules/remote-access/device-proof.testing'

// Account access end to end, on the harness in `app.tunnel.testing.ts`: relay
// tickets with device proofs, approval, revocation and disconnect.
useTunnelHarness()

const MACHINE_KEY = routes.system.machineKey.path

/** Sends the key bootstrap with a fresh relay ticket and `who`'s proof, as tunneled request `id`. */
async function bootstrap(conn: Conn, who: Awaited<ReturnType<typeof testDevice>>, id: number) {
  const headers = await credentialHeaders({ ticket: accountTicket() }, 'GET', MACHINE_KEY, '', who)
  send(conn, { type: 'http.request', id, method: 'GET', path: MACHINE_KEY, headers })
}

describe('tunneled account access', () => {
  test('a relay ticket opens requests and sockets only for an approved device, never local-only routes, and revoke and unlink end them', async () => {
    const conn = await welcomed()
    const response = (id: number) => conn.frames.find((f) => f.type === 'http.response' && f.id === id)
    const body = (id: number) =>
      Buffer.concat(conn.frames.flatMap((f) => (f.type === 'http.body' && f.id === id ? [f.data] : []))).toString()
    const [first, second] = await Promise.all([testDevice(), testDevice()])
    const closes = () => conn.frames.filter((f) => f.type === 'ws.close')

    // Before approval: a 403 with no `auth.failed`, and the device waits on the machine.
    await bootstrap(conn, first, 1)
    await until(() => response(1) !== undefined)
    expect(response(1)).toMatchObject({ status: 403 })
    expect(JSON.parse(body(1))).toMatchObject({ code: DEVICE_NOT_APPROVED_CODE })
    expect(conn.frames.some((f) => f.type === 'auth.failed')).toBe(false)
    await bootstrap(conn, second, 2)
    await until(() => response(2) !== undefined)
    expect(remoteAccess.listDevices().pending.map((d) => d.id)).toEqual([second.id, first.id])

    remoteAccess.approveDevice(fingerprintOf(first.id))
    remoteAccess.approveDevice(fingerprintOf(second.id))
    const ofFirst = await openE2eSession(conn, 3, { ticket: accountTicket() }, first)
    const asFirst = () => ({ as: { ticket: accountTicket() }, who: first })
    const statuses: number[] = []
    for (const [id, method, path] of [
      [4, 'GET', routes.system.health.path],
      [5, 'POST', routes.access.rotate.path],
      [6, 'GET', routes.remoteAccess.devices.path],
      [7, 'POST', routes.remoteAccess.approveDevice.path],
      [8, 'GET', routes.remoteAccess.sessions.path],
      [9, 'POST', routes.remoteAccess.endSession.path],
    ] as const) {
      statuses.push((await sealedRequest(conn, ofFirst, id, method, path, asFirst())).status ?? 0)
    }
    expect(statuses).toEqual([200, 403, 403, 403, 403, 403])

    const ofSecond = await openE2eSession(conn, 10, { ticket: accountTicket() }, second)
    await sealedSocket(conn, ofFirst, 2, '/ws/term/t1', asFirst())
    await sealedSocket(conn, ofSecond, 3, '/ws/term/t1', { as: { ticket: accountTicket() }, who: second })
    await until(() => stub.attached.size === 2)

    remoteAccess.removeDevice(first.id)
    await until(() => stub.attached.size === 1 && closes().length === 1)
    expect(closes().at(-1)).toEqual({
      type: 'ws.close',
      channel: 2,
      code: CLOSE_ACCESS_DENIED,
      reason: 'device revoked',
    })

    // Disconnect asks the server to remove the machine, closes the account's sockets, then stops the tunnel.
    expect((await remoteAccess.disconnect()).removedFromAccount).toBe(true)
    await until(() => stub.attached.size === 0 && closes().length === 2)
    expect(closes().at(-1)).toEqual({ type: 'ws.close', channel: 3, code: CLOSE_ACCESS_DENIED, reason: 'disconnected' })
    expect(conn.frames.filter((f) => f.type === 'unlink')).toEqual([
      { type: 'unlink', id: expect.any(Number), accountId: ACCOUNT_ID },
    ])
    expect(conn.frames.at(-1)).toEqual({ type: 'remote.off' })
  })

  test('the sessions list counts the authorized sockets of each approved device by credential, and End closes one device without revoking it', async () => {
    const conn = await welcomed()
    const path = '/ws/term/t1'
    const response = (id: number) => conn.frames.find((f) => f.type === 'http.response' && f.id === id)
    const [first, second] = await Promise.all([testDevice(), testDevice()])
    const sessions = async () => {
      const answer = await fetch(`http://127.0.0.1:${local.port}${routes.remoteAccess.sessions.path}`)
      return { text: await answer.text(), status: answer.status }
    }
    const end = (id: string) =>
      fetch(`http://127.0.0.1:${local.port}${routes.remoteAccess.endSession.path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      })
    expect(JSON.parse((await sessions()).text)).toEqual({ sessions: [] })

    for (const [id, device] of [first, second].entries()) await bootstrap(conn, device, id + 1)
    await until(() => response(1) !== undefined && response(2) !== undefined)
    remoteAccess.approveDevice(fingerprintOf(first.id))
    remoteAccess.approveDevice(fingerprintOf(second.id))
    const laptop = keys.create('laptop')
    const firstAccount = await openE2eSession(conn, 3, { ticket: accountTicket() }, first)
    const firstLaptop = await openE2eSession(conn, 4, { key: laptop }, first)
    const secondAccount = await openE2eSession(conn, 5, { ticket: accountTicket() }, second)
    const account = (who: typeof first) => ({ as: { ticket: accountTicket() }, who })

    const before = Date.now()
    await sealedSocket(conn, firstAccount, 1, path, account(first))
    await until(() => stub.attached.size === 1)
    const afterFirst = Date.now()
    await sealedSocket(conn, firstAccount, 2, path, account(first))
    await sealedSocket(conn, firstLaptop, 3, path, { as: { key: laptop }, who: first })
    await sealedSocket(conn, secondAccount, 4, path, account(second))
    // Refused as unsealed, so not counted.
    send(conn, { type: 'ws.open', channel: 5, path, headers: [] })
    await until(() => stub.attached.size === 4)

    const listed = await sessions()
    const { sessions: open } = JSON.parse(listed.text)
    const ofFirst = open.find((session: { deviceId: string }) => session.deviceId === first.id)
    expect(ofFirst).toMatchObject({ fingerprint: fingerprintOf(first.id), sockets: 3 })
    expect(ofFirst.credentials).toHaveLength(2)
    expect(ofFirst.credentials).toEqual(expect.arrayContaining([{ kind: 'account' }, { kind: 'key', name: 'laptop' }]))
    expect(Date.parse(ofFirst.startedAt)).toBeGreaterThanOrEqual(before)
    expect(Date.parse(ofFirst.startedAt)).toBeLessThanOrEqual(afterFirst)
    expect(open.find((session: { deviceId: string }) => session.deviceId === second.id)).toMatchObject({ sockets: 1 })
    for (const hidden of [laptop, ACCOUNT_ID, first.publicKey.x, second.publicKey.x]) {
      expect(listed.text).not.toContain(hidden)
    }

    const ended = await end(first.id)
    expect(ended.status).toBe(200)
    expect((await ended.json()).sessions.map((session: { deviceId: string }) => session.deviceId)).toEqual([second.id])
    await until(() => stub.attached.size === 1)
    // Channel 5 was refused as unsealed, which is not End's doing.
    const closes = conn.frames.filter((f) => f.type === 'ws.close' && f.channel !== 5)
    expect(closes.map((f) => f.type === 'ws.close' && [f.channel, f.code, f.reason])).toEqual([
      [1, CLOSE_ACCESS_DENIED, 'session ended by owner'],
      [2, CLOSE_ACCESS_DENIED, 'session ended by owner'],
      [3, CLOSE_ACCESS_DENIED, 'session ended by owner'],
    ])
    expect(remoteAccess.listDevices().approved.map((d) => d.id)).toContain(first.id)

    expect((await end('A'.repeat(43))).status).toBe(200)
    expect((await end('not an id')).status).toBe(400)
    expect(JSON.parse((await sessions()).text).sessions).toHaveLength(1)
  })
})
