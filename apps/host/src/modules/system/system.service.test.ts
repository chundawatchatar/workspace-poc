import { describe, expect, test } from 'bun:test'
import { daemonStatus } from './system.service'

const now = 1_700_000_000_000
const state = { compatibility: 'current' as const, daemonProtocol: 1, stopCommand: 'bun run terminals:stop' }

describe('daemonStatus', () => {
  test('reports the time since the daemon started while terminals are live, with its compatibility', () => {
    expect(daemonStatus({ ...state, startedAt: now - 90_000, liveTerminals: 2, now })).toEqual({
      ...state,
      uptimeMs: 90_000,
      liveTerminals: 2,
    })
  })

  test('leaves the uptime unknown without a start time or without live terminals', () => {
    // No status yet, or one from an older daemon that sends no start time.
    expect(daemonStatus({ ...state, startedAt: null, liveTerminals: 2, now }).uptimeMs).toBeNull()
    // The start time may belong to a daemon that has exited since.
    expect(daemonStatus({ ...state, startedAt: now - 90_000, liveTerminals: 0, now }).uptimeMs).toBeNull()
  })
})
