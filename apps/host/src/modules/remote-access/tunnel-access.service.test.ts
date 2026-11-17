import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { CLOSE_SESSION_ENDED, type RelayTicketPayload } from '@orch/shared'
import { deviceKeyFingerprint } from '@orch/terminal-ui/device-proof'
import type { Principal } from '../../lib/principal'
import { type Credentials, DEVICE_NOT_APPROVED } from '../tunnel/tunnel-http.service'
import { fingerprintOf } from './device-proof.service'
import { testDevice } from './device-proof.testing'
import {
  account,
  accountId,
  connected,
  devicesFile,
  expiresAt,
  linkedFile,
  relay,
  relayKeys,
  service,
  tunnels,
  useRemoteAccessHarness,
} from './remote-access.testing'

// Access through the tunnel, as `RemoteAccessService.authorize` decides it with `TunnelAccess`.
useRemoteAccessHarness()

describe('RemoteAccessService.authorize', () => {
  /** Writes the linked account file a previous run saved. */
  const writeLinked = (fields: Record<string, unknown>) =>
    writeFileSync(
      linkedFile(),
      JSON.stringify({ ...account, serverUrl: 'ws://127.0.0.1:4600', linkedAt: expiresAt, ...fields }),
    )
  /** A ticket for this machine and the linked account, changed by `overrides`. */
  const ticketFor = (overrides: Partial<RelayTicketPayload> = {}) =>
    relay.ticket({ sub: accountId, aud: service.status().machineId ?? '', ...overrides })
  const authorize = (credentials: Credentials) => tunnels.at(-1)?.options.authorize(credentials)

  test('a ticket opens as the linked account only with a fresh proof from an approved device', async () => {
    writeLinked({ accountId, relayKeys })
    connected()
    const machineId = service.status().machineId ?? ''
    const device = await testDevice()
    const health = { machineId, method: 'GET', path: '/api/health' }
    const ticketExp = Math.floor(Date.now() / 1000) + 60
    const ticket = ticketFor({ exp: ticketExp })

    // An unknown device with a valid ticket waits for approval, listed once by the fingerprint its browser shows.
    expect(authorize({ ticket, device: await device.presented(health) })).toBe(DEVICE_NOT_APPROVED)
    expect(authorize({ ticket, device: await device.presented(health) })).toBe(DEVICE_NOT_APPROVED)
    const fingerprint = await deviceKeyFingerprint(device.signer.publicJwk)
    expect(service.listDevices()).toEqual({
      pending: [{ id: device.id, fingerprint, firstSeenAt: expect.any(String) }],
      approved: [],
    })

    // Without a valid ticket nothing is recorded, however good the proof.
    const stranger = await testDevice()
    const bad = ticketFor({ sub: 'someone-else' })
    expect(authorize({ ticket: bad, device: await stranger.presented(health) })).toBeNull()
    expect(service.listDevices().pending.map((d) => d.id)).toEqual([device.id])

    expect(service.approveDevice(fingerprint.toLowerCase()).approved).toEqual([
      { id: device.id, fingerprint, approvedAt: expect.any(String) },
    ])
    // The principal carries the ticket's `exp`, so what it opens can end with the ticket.
    const asAccount: Principal = { kind: 'account', accountId, deviceId: device.id, ticketExp }
    const proof = await device.presented(health)
    expect(authorize({ ticket, device: proof })).toEqual(asAccount)
    // A used proof, no proof, a proof for another request, and a valid proof with a bad ticket are all refused.
    expect(authorize({ ticket, device: proof })).toBeNull()
    expect(authorize({ ticket, device: null })).toBeNull()
    const elsewhere = await device.presented({ ...health, path: '/api/git/status' })
    expect(authorize({ ticket, device: { ...elsewhere, path: '/api/health' } })).toBeNull()
    expect(authorize({ ticket: bad, device: await device.presented(health) })).toBeNull()
    expect(authorize({ ticket: null, device: await device.presented(health) })).toBeNull()

    // A socket spends its ticket, so the same ticket with a fresh proof opens nothing more.
    const socket = { machineId, method: 'WS', path: '/ws/events' }
    expect(authorize({ ticket, device: await device.presented(socket), once: true })).toEqual(asAccount)
    expect(authorize({ ticket, device: await device.presented(socket), once: true })).toBeNull()

    // Approval survives a restart.
    service.shutdown()
    connected()
    expect(service.listDevices().approved.map((d) => d.id)).toEqual([device.id])
    expect(authorize({ ticket: ticketFor(), device: await device.presented(health) })).toEqual(asAccount)
  })

  test('a refused ticket never reads its proof, and a valid one still needs a fresh proof for this request and machine', async () => {
    writeLinked({ accountId, relayKeys })
    connected()
    const machineId = service.status().machineId ?? ''
    const device = await testDevice()
    const health = { machineId, method: 'GET', path: '/api/health' }
    const ticket = ticketFor()

    // A forged ticket, or none, with a valid proof is refused, records no device and spends no nonce.
    const proof = await device.presented(health)
    expect(authorize({ ticket: `${ticket.slice(0, -2)}xx`, device: proof })).toBeNull()
    expect(authorize({ ticket: null, device: proof })).toBeNull()
    expect(service.listDevices().pending).toEqual([])
    // No proof, a proof for another request, another machine or a stale one are refused, and record nothing.
    expect(authorize({ ticket, device: null })).toBeNull()
    expect(authorize({ ticket })).toBeNull()
    const elsewhere = await device.presented({ ...health, path: '/api/git/status' })
    expect(authorize({ ticket, device: { ...elsewhere, path: '/api/health' } })).toBeNull()
    const foreign = await device.presented({ ...health, machineId: 'another-machine' })
    expect(authorize({ ticket, device: foreign })).toBeNull()
    const stale = await device.presented(health, Date.now() - 10 * 60_000)
    expect(authorize({ ticket, device: stale })).toBeNull()
    expect(service.listDevices().pending).toEqual([])

    // The proof the forged ticket carried is still unspent: with the valid ticket it lists the device as waiting.
    expect(authorize({ ticket, device: proof })).toBe(DEVICE_NOT_APPROVED)
    expect(authorize({ ticket, device: proof })).toBeNull()
    expect(service.listDevices().pending.map((d) => d.id)).toEqual([device.id])
  })

  test('revoking a device closes only its channels and refuses it, and disconnect forgets every device', async () => {
    writeLinked({ accountId, relayKeys })
    const { tunnel } = connected()
    const machineId = service.status().machineId ?? ''
    const health = { machineId, method: 'GET', path: '/api/health' }
    const [kept, revoked, waiting] = await Promise.all([testDevice(), testDevice(), testDevice()])
    for (const device of [kept, revoked, waiting]) {
      authorize({ ticket: ticketFor(), device: await device.presented(health) })
    }
    service.approveDevice(fingerprintOf(kept.id))
    service.approveDevice(fingerprintOf(revoked.id))

    expect(service.removeDevice(revoked.id).approved.map((d) => d.id)).toEqual([kept.id])
    expect(tunnel.closed.map((c) => c.reason)).toEqual(['device revoked'])
    const [closed] = tunnel.closed
    expect(closed?.revoked({ kind: 'account', accountId, deviceId: revoked.id, ticketExp: 0 })).toBe(true)
    expect(closed?.revoked({ kind: 'account', accountId, deviceId: kept.id, ticketExp: 0 })).toBe(false)
    const next = authorize({ ticket: ticketFor(), device: await revoked.presented(health) })
    expect(next).toBe(DEVICE_NOT_APPROVED)
    expect(JSON.parse(readFileSync(devicesFile(), 'utf8')).map((d: { id: string }) => d.id)).toEqual([kept.id])

    // Dismissing a waiting device closes nothing.
    service.removeDevice(waiting.id)
    expect(service.listDevices().pending.map((d) => d.id)).toEqual([revoked.id])
    expect(tunnel.closed).toHaveLength(1)

    await service.disconnect()
    expect(service.listDevices()).toEqual({ pending: [], approved: [] })
    expect(existsSync(devicesFile())).toBe(false)
  })

  test("session.ended closes only the linked account's sockets, and changes no link or device", async () => {
    writeLinked({ accountId, relayKeys })
    const { tunnel } = connected()
    const machineId = service.status().machineId ?? ''
    const health = { machineId, method: 'GET', path: '/api/health' }
    const [approved, waiting] = await Promise.all([testDevice(), testDevice()])
    for (const device of [approved, waiting]) {
      authorize({ ticket: ticketFor(), device: await device.presented(health) })
    }
    service.approveDevice(fingerprintOf(approved.id))
    const viaTicket: Principal = { kind: 'account', accountId, deviceId: approved.id, ticketExp: 0 }
    const otherAccount: Principal = { kind: 'account', accountId: 'acct-bob-2', deviceId: approved.id, ticketExp: 0 }
    const persisted = () => ({
      linked: readFileSync(linkedFile(), 'utf8'),
      devices: readFileSync(devicesFile(), 'utf8'),
      list: service.listDevices(),
    })
    const unchanged = persisted()
    const ended = (id: string) => tunnel.options.onSessionEnded?.(id)

    ended(accountId)
    expect(tunnel.closed.map(({ reason, code }) => ({ reason, code }))).toEqual([
      { reason: 'session ended', code: CLOSE_SESSION_ENDED },
    ])
    const [closed] = tunnel.closed
    expect([viaTicket, otherAccount].map((p) => closed?.revoked(p))).toEqual([true, false])
    expect(persisted()).toEqual(unchanged)

    // Another account, or no linked account at all, closes nothing.
    ended('acct-bob-2')
    expect(tunnel.closed).toHaveLength(1)
    expect(persisted()).toEqual(unchanged)
    await service.disconnect()
    const afterDisconnect = tunnel.closed.length
    ended(accountId)
    expect(tunnel.closed).toHaveLength(afterDisconnect)
  })

  test('an older linked file still shows the account but accepts no ticket, nor does another server', () => {
    for (const fields of [{}, { accountId }]) {
      writeLinked(fields)
      connected()
      expect(service.status().linkedAccount).toMatchObject(account)
      expect(authorize({ ticket: ticketFor() })).toBeNull()
      service.shutdown()
    }
    writeLinked({ accountId, relayKeys, serverUrl: 'wss://other.example.com' })
    connected()
    expect(authorize({ ticket: ticketFor() })).toBeNull()
  })
})
