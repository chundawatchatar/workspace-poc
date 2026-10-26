import { describe, expect, test } from 'bun:test'
import { daemonStatus } from './system.service'

const now = 1_700_000_000_000

describe('daemonStatus', () => {
  test('reports the time since the daemon started while terminals are live', () => {
    expect(daemonStatus({ startedAt: now - 90_000, liveTerminals: 2, now })).toEqual({
      uptimeMs: 90_000,
      liveTerminals: 2,
    })
  })

  test('leaves the uptime unknown without a start time or without live terminals', () => {
    // No status yet, or one from an older daemon that sends no start time.
    expect(daemonStatus({ startedAt: null, liveTerminals: 2, now })).toEqual({ uptimeMs: null, liveTerminals: 2 })
    // The start time may belong to a daemon that has exited since.
    expect(daemonStatus({ startedAt: now - 90_000, liveTerminals: 0, now })).toEqual({
      uptimeMs: null,
      liveTerminals: 0,
    })
  })
})
