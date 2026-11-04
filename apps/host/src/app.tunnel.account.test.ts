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

    remoteAccess.approveDevice(first.id)
    remoteAccess.approveDevice(second.id)
    await request(first, 3, routes.system.health.path)
    await request(first, 4, routes.access.rotate.path, 'POST')
    await request(first, 5, routes.remoteAccess.devices.path)
    await until(() => [3, 4, 5].every((id) => response(id) !== undefined))
    expect([3, 4, 5].map(response)).toMatchObject([{ status: 200 }, { status: 403 }, { status: 403 }])

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
})
