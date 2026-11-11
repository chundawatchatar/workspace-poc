import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fingerprintOf } from './device-proof.service'
import { DevicesRepository } from './devices.repository'
import { DevicesService, MAX_PENDING_DEVICES, PENDING_DEVICE_TTL_MS } from './devices.service'

const publicKey = { kty: 'EC', crv: 'P-256', x: 'x'.repeat(43), y: 'y'.repeat(43) } as const
/** Device ids that differ in their first character, so each has its own fingerprint. */
const id = (n: number) => `${n}${'d'.repeat(42)}`

let dir: string
let clock: number
let log: ReturnType<typeof spyOn<Console, 'log'>>
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orch-devices-'))
  clock = Date.UTC(2026, 10, 4, 12)
  log = spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  mock.restore()
  rmSync(dir, { recursive: true, force: true })
})

/** The lines `console.log` was called with, in order. */
const logged = () => log.mock.calls.map((args) => args.join(' '))

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
    expect(devices.approve(fingerprintOf(id(3)))).toBe('none')
    clock += 2000
    expect(devices.list().pending).toEqual([])
  })

  test('an approved device is saved and loaded at start, and clear forgets every device', () => {
    const devices = setup()
    devices.recordPending(id(1), publicKey)
    devices.recordPending(id(2), publicKey)
    expect(devices.approve(fingerprintOf(id(1)))).toBe('approved')
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

  test('approve takes the typed fingerprint in any case, with or without dashes, and approves only one match', () => {
    const devices = setup()
    devices.recordPending(id(1), publicKey)
    devices.recordPending(id(2), publicKey)
    const typed = `  ${fingerprintOf(id(1)).replaceAll('-', '').toLowerCase()} `
    expect(devices.approve(typed)).toBe('approved')
    expect(devices.list().approved.map((d) => d.id)).toEqual([id(1)])
    expect(devices.approve(fingerprintOf(id(1)))).toBe('already')
    expect(devices.list().approved).toHaveLength(1)

    for (const typed of ['', ' - ', 'not-a-fingerprint', fingerprintOf(id(9))]) {
      expect(devices.approve(typed)).toBe('none')
    }
    expect(devices.list().pending.map((d) => d.id)).toEqual([id(2)])
  })

  test('a fingerprint that more than one waiting device shares approves none of them', () => {
    const devices = setup()
    // Same first 10 bytes, so the same fingerprint.
    const twins = [`${'d'.repeat(42)}A`, `${'d'.repeat(42)}B`]
    for (const twin of twins) devices.recordPending(twin, publicKey)
    expect(devices.approve(fingerprintOf(twins[0] ?? ''))).toBe('several')
    expect(devices.list().approved).toEqual([])
    expect(devices.list().pending).toHaveLength(2)
  })

  test('a newly waiting device logs one line with only its fingerprint and time', () => {
    const devices = setup()
    devices.recordPending(id(1), publicKey)
    const lines = logged()
    expect(lines).toEqual([
      `device ${fingerprintOf(id(1))} asks for approval (${new Date(clock).toISOString()}); approve it in Remote access or with bun run host:remote devices approve`,
    ])
    expect(lines[0]).not.toContain(id(1))
    for (const field of [publicKey.x, publicKey.y, 'P-256', 'kty']) expect(lines[0]).not.toContain(field)
  })

  test('logs again only once a device is new to the list, after it expired or was pushed out', () => {
    const devices = setup()
    devices.recordPending(id(1), publicKey)
    devices.recordPending(id(1), publicKey)
    expect(devices.approve(fingerprintOf(id(1)))).toBe('approved')
    devices.recordPending(id(1), publicKey)
    expect(logged()).toHaveLength(1)

    devices.recordPending(id(2), publicKey)
    clock += PENDING_DEVICE_TTL_MS
    devices.recordPending(id(2), publicKey)
    expect(logged()).toHaveLength(3)

    for (let n = 3; n < 3 + MAX_PENDING_DEVICES; n++) {
      clock += 1000
      devices.recordPending(id(n), publicKey)
    }
    expect(devices.list().pending.map((d) => d.id)).not.toContain(id(2))
    devices.recordPending(id(2), publicKey)
    expect(logged()).toHaveLength(4 + MAX_PENDING_DEVICES)
    expect(logged().at(-1)).toContain(fingerprintOf(id(2)))
  })
})
