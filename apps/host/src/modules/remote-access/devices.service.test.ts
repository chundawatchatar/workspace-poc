import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DevicesRepository } from './devices.repository'
import { DevicesService, PENDING_DEVICE_TTL_MS } from './devices.service'

const publicKey = { kty: 'EC', crv: 'P-256', x: 'x'.repeat(43), y: 'y'.repeat(43) } as const
const id = (n: number) => `${'d'.repeat(42)}${n}`

let dir: string
let clock: number
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orch-devices-'))
  clock = Date.UTC(2026, 10, 4, 12)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function setup() {
  const devices = new DevicesService(new DevicesRepository(join(dir, 'devices.json')), () => clock)
  devices.start()
  return devices
}

describe('DevicesService', () => {
  test('keeps at most five waiting devices, newest first, once each, for 15 minutes', () => {
    const devices = setup()
    for (const n of [1, 2, 3, 4, 5, 6, 7, 7]) {
      devices.recordPending(id(n), publicKey)
      clock += 1000
    }
    expect(devices.list().pending.map((d) => d.id)).toEqual([7, 6, 5, 4, 3].map(id))
    clock += PENDING_DEVICE_TTL_MS - 4000
    expect(devices.list().pending.map((d) => d.id)).toEqual([7, 6].map(id))
    expect(devices.approve(id(3))).toBe(false)
    clock += 2000
    expect(devices.list().pending).toEqual([])
  })

  test('an approved device is saved and loaded at start, and clear forgets every device', () => {
    const devices = setup()
    devices.recordPending(id(1), publicKey)
    devices.recordPending(id(2), publicKey)
    expect(devices.approve(id(1))).toBe(true)
    expect(devices.list().pending.map((d) => d.id)).toEqual([id(2)])

    const restarted = setup()
    expect(restarted.isApproved(id(1))).toBe(true)
    expect(restarted.list()).toEqual({
      pending: [],
      approved: [{ id: id(1), fingerprint: expect.any(String), approvedAt: new Date(clock).toISOString() }],
    })
    restarted.clear()
    expect(setup().list().approved).toEqual([])
  })
})
