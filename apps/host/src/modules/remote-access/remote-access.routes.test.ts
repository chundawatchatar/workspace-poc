import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { routes } from '@orch/shared'
import { AuditLogRepository } from './audit-log.repository'
import { AuditLogService } from './audit-log.service'
import { fingerprintOf } from './device-proof.service'
import { DevicesRepository } from './devices.repository'
import type { DevicesService } from './devices.service'
import { LinkedAccountRepository } from './linked-account.repository'
import { RemoteAccessRepository } from './remote-access.repository'
import { createRemoteAccessRoutes } from './remote-access.routes'
import { RemoteAccessService } from './remote-access.service'

const publicKey = { kty: 'EC', crv: 'P-256', x: 'x'.repeat(43), y: 'y'.repeat(43) } as const
/** Device ids that differ in their first character, so each has its own fingerprint. */
const id = (n: number) => `${n}${'d'.repeat(42)}`
const notWaiting = (typed: string) =>
  `No browser with the fingerprint ${typed} is waiting. Open this machine in your own browser and type the fingerprint it shows.`

let dir: string
let service: RemoteAccessService
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orch-remote-routes-'))
  service = new RemoteAccessService({
    repository: new RemoteAccessRepository(join(dir, 'remote-access.json')),
    linkedAccounts: new LinkedAccountRepository(join(dir, 'linked-account.json')),
    devices: new DevicesRepository(join(dir, 'devices.json')),
    audit: new AuditLogService(new AuditLogRepository(join(dir, 'remote-audit.jsonl'))),
    secretFile: join(dir, 'machine-secret'),
    keysFile: join(dir, 'access-keys.json'),
    handle: async () => new Response('ok'),
    openSocket: () => ({ code: 1008, reason: 'none' }),
  })
  service.start()
})
afterEach(() => {
  service.shutdown()
  rmSync(dir, { recursive: true, force: true })
})

/** Records waiting devices directly, as a valid ticket and proof would (that path is in the service test). */
function waiting(...ids: string[]) {
  const devices = (service as unknown as { devices: DevicesService }).devices
  for (const deviceId of ids) devices.recordPending(deviceId, publicKey)
}

async function approve(body: unknown) {
  const app = createRemoteAccessRoutes({ remoteAccess: service })
  const response = await app.request(routes.remoteAccess.approveDevice.path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, text, json: () => JSON.parse(text) }
}

describe('approveDevice', () => {
  test('takes only a typed fingerprint, and one that matches no waiting browser gets one 404 message', async () => {
    waiting(id(1), id(2))
    const fingerprint = fingerprintOf(id(1))

    for (const body of [
      { id: id(1) },
      { fingerprint, id: id(1) },
      {},
      { fingerprint: '' },
      { fingerprint: 'X'.repeat(65) },
    ]) {
      expect((await approve(body)).status).toBe(400)
    }
    for (const typed of ['ZZZZ-ZZZZ-ZZZZ-ZZZZ', 'not a fingerprint', fingerprintOf(id(9))]) {
      expect(await approve({ fingerprint: typed })).toMatchObject({ status: 404, text: notWaiting(typed) })
    }
    expect(service.listDevices().approved).toEqual([])

    const approved = await approve({ fingerprint: `  ${fingerprint.replaceAll('-', '').toLowerCase()}\n` })
    expect(approved.status).toBe(200)
    expect(approved.json()).toEqual(service.listDevices())
    expect(service.listDevices().approved.map((d) => d.id)).toEqual([id(1)])
    expect(service.listDevices().pending.map((d) => d.id)).toEqual([id(2)])

    // Approving it again changes nothing and is not an error.
    const again = await approve({ fingerprint })
    expect(again.status).toBe(200)
    expect(again.json()).toEqual(approved.json())
  })

  test('a fingerprint more than one waiting browser shares gets a 409 and approves none', async () => {
    // Same first 10 bytes, so the same fingerprint.
    const twins = [`${'d'.repeat(42)}A`, `${'d'.repeat(42)}B`]
    waiting(...twins)
    const answer = await approve({ fingerprint: fingerprintOf(twins[0] ?? '') })
    expect(answer.status).toBe(409)
    expect(answer.text).toContain('More than one browser has the fingerprint')
    expect(service.listDevices()).toMatchObject({ approved: [], pending: [{}, {}] })
  })
})
