import { describe, expect, test } from 'bun:test'
import { deviceNotices } from './pendingDevices'

describe('deviceNotices', () => {
  test('keeps only the fingerprint and time of each waiting browser, in order, and none of the approved', () => {
    const seen = (minute: number) => `2026-11-04T12:0${minute}:00.000Z`
    expect(
      deviceNotices({
        pending: [
          { id: 'b'.repeat(43), fingerprint: 'BBBB-BBBB-BBBB-BBBB', firstSeenAt: seen(2) },
          { id: 'a'.repeat(43), fingerprint: 'AAAA-AAAA-AAAA-AAAA', firstSeenAt: seen(1) },
        ],
        approved: [{ id: 'c'.repeat(43), fingerprint: 'CCCC-CCCC-CCCC-CCCC', approvedAt: seen(0) }],
      }),
    ).toEqual([
      { fingerprint: 'BBBB-BBBB-BBBB-BBBB', firstSeenAt: seen(2) },
      { fingerprint: 'AAAA-AAAA-AAAA-AAAA', firstSeenAt: seen(1) },
    ])
  })
})
