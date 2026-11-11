import { describe, expect, test } from 'bun:test'
import {
  CLOSE_ACCESS_DENIED,
  CLOSE_DEVICE_NOT_APPROVED,
  DEVICE_PROOF_HEADER,
  RELAY_TICKET_HEADER,
  relaySocketProtocols,
  routes,
} from '@orch/shared'
import {
  ACCOUNT_ID,
  keys,
  local,
  relay,
  remoteAccess,
  secret,
  send,
  server,
  stub,
  until,
  useTunnelHarness,
  welcomed,
} from './app.tunnel.testing'
import { machineIdFromSecret } from './modules/access/access.service'
import { fingerprintOf } from './modules/remote-access/device-proof.service'
import { testDevice } from './modules/remote-access/device-proof.testing'

// Account access end to end, on the harness in `app.tunnel.testing.ts`: relay
// tickets with device proofs, approval, revocation and unlink.
useTunnelHarness()

describe('tunneled account access', () => {
  test('a relay ticket opens requests and sockets only for an approved device, never local-only routes, and revoke and unlink end them', async () => {
    const conn = await welcomed()
    const machineId = machineIdFromSecret(secret)
    const response = (id: number) => conn.frames.find((f) => f.type === 'http.response' && f.id === id)
    const ticket = () => relay.ticket({ sub: ACCOUNT_ID, aud: machineId })
    const [first, second] = await Promise.all([testDevice(), testDevice()])
    const request = async (device: typeof first, id: number, path: string, method = 'GET') => {
      const proof = await device.proof({ machineId, method, path })
      const headers: [string, string][] = [
        [RELAY_TICKET_HEADER, ticket()],
        [DEVICE_PROOF_HEADER, proof],
      ]
      send(conn, { type: 'http.request', id, method, path, headers })
    }
    const socket = async (device: typeof first, channel: number) => {
      const headers: [string, string][] = [['sec-websocket-protocol', relaySocketProtocols(ticket()).join(', ')]]
      send(conn, { type: 'ws.open', channel, path: '/ws/term/t1', headers })
      const proof = await device.socket(machineId, '/ws/term/t1')
      send(conn, { type: 'ws.data', channel, data: JSON.stringify({ type: 'auth', account: true, device: proof }) })
    }
    const closes = () => conn.frames.filter((f) => f.type === 'ws.close')
    await remoteAccess.link({ key: `oek_${'k'.repeat(43)}`, serverUrl: `ws://127.0.0.1:${server.port}` })

    // Before approval: a 403 and a close of its own, with no `auth.failed`, and the device waits on the machine.
    await request(first, 1, routes.system.health.path)
    await socket(first, 1)
    await until(() => response(1) !== undefined && closes().length === 1)
    expect(response(1)).toMatchObject({ status: 403 })
    expect(closes()).toEqual([
      { type: 'ws.close', channel: 1, code: CLOSE_DEVICE_NOT_APPROVED, reason: 'device not approved' },
    ])
    expect(conn.frames.some((f) => f.type === 'auth.failed')).toBe(false)
    await request(second, 2, routes.system.health.path)
    await until(() => response(2) !== undefined)
    expect(remoteAccess.listDevices().pending.map((d) => d.id)).toEqual([second.id, first.id])

    remoteAccess.approveDevice(fingerprintOf(first.id))
    remoteAccess.approveDevice(fingerprintOf(second.id))
    await request(first, 3, routes.system.health.path)
    await request(first, 4, routes.access.rotate.path, 'POST')
    await request(first, 5, routes.remoteAccess.devices.path)
    await request(first, 6, routes.remoteAccess.approveDevice.path, 'POST')
    await request(first, 7, routes.remoteAccess.sessions.path)
    await request(first, 8, routes.remoteAccess.endSession.path, 'POST')
    await until(() => [3, 4, 5, 6, 7, 8].every((id) => response(id) !== undefined))
    expect([3, 4, 5, 6, 7, 8].map(response)).toMatchObject([
      { status: 200 },
      { status: 403 },
      { status: 403 },
      { status: 403 },
      { status: 403 },
      { status: 403 },
    ])

    await socket(first, 2)
    await socket(second, 3)
    await until(() => stub.attached.size === 2)

    remoteAccess.removeDevice(first.id)
    await until(() => stub.attached.size === 1 && closes().length === 2)
    expect(closes().at(-1)).toEqual({
      type: 'ws.close',
      channel: 2,
      code: CLOSE_ACCESS_DENIED,
      reason: 'device revoked',
    })

    remoteAccess.unlink()
    await until(() => stub.attached.size === 0 && closes().length === 3)
    expect(closes().at(-1)).toEqual({
      type: 'ws.close',
      channel: 3,
      code: CLOSE_ACCESS_DENIED,
      reason: 'account unlinked',
    })
  })

  test('the sessions list counts the authorized sockets of each approved device by credential, and End closes one device without revoking it', async () => {
    const conn = await welcomed()
    const machineId = machineIdFromSecret(secret)
    const path = '/ws/term/t1'
    const response = (id: number) => conn.frames.find((f) => f.type === 'http.response' && f.id === id)
    const [first, second] = await Promise.all([testDevice(), testDevice()])
    const ticketHeaders = (): [string, string][] => [
      ['sec-websocket-protocol', relaySocketProtocols(relay.ticket({ sub: ACCOUNT_ID, aud: machineId })).join(', ')],
    ]
    const accountSocket = async (device: typeof first, channel: number) => {
      send(conn, { type: 'ws.open', channel, path, headers: ticketHeaders() })
      const proof = await device.socket(machineId, path)
      send(conn, { type: 'ws.data', channel, data: JSON.stringify({ type: 'auth', account: true, device: proof }) })
    }
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

    await remoteAccess.link({ key: `oek_${'k'.repeat(43)}`, serverUrl: `ws://127.0.0.1:${server.port}` })
    for (const [id, device] of [first, second].entries()) {
      const proof = await device.proof({ machineId, method: 'GET', path: routes.system.health.path })
      const headers: [string, string][] = [
        [RELAY_TICKET_HEADER, relay.ticket({ sub: ACCOUNT_ID, aud: machineId })],
        [DEVICE_PROOF_HEADER, proof],
      ]
      send(conn, { type: 'http.request', id: id + 1, method: 'GET', path: routes.system.health.path, headers })
    }
    await until(() => response(1) !== undefined && response(2) !== undefined)
    remoteAccess.approveDevice(fingerprintOf(first.id))
    remoteAccess.approveDevice(fingerprintOf(second.id))
    const laptop = keys.create('laptop')

    const before = Date.now()
    await accountSocket(first, 1)
    await until(() => stub.attached.size === 1)
    const afterFirst = Date.now()
    await accountSocket(first, 2)
    send(conn, { type: 'ws.open', channel: 3, path, headers: [] })
    const keyProof = await first.socket(machineId, path)
    send(conn, { type: 'ws.data', channel: 3, data: JSON.stringify({ type: 'auth', key: laptop, device: keyProof }) })
    await accountSocket(second, 4)
    // Waiting for its auth message, so not counted.
    send(conn, { type: 'ws.open', channel: 5, path, headers: ticketHeaders() })
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
    // Channel 5 may have timed out by now, which is not End's doing.
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
