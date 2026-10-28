import { describe, expect, test } from 'bun:test'
import { ConnectionLimiter, type ConnectionLimiterDeps } from './limits.service'

/** A limiter on a fake clock, with small buckets. */
function setup(deps: ConnectionLimiterDeps = {}) {
  const clock = { now: 0 }
  const limiter = new ConnectionLimiter({
    perIp: { capacity: 2, refillEveryMs: 1000 },
    perMachine: { capacity: 3, refillEveryMs: 1000 },
    tunnelPerIp: { capacity: 1, refillEveryMs: 10_000 },
    badKeysPerIp: { capacity: 2, refillEveryMs: 60_000 },
    now: () => clock.now,
    ...deps,
  })
  return { limiter, clock }
}

describe('ConnectionLimiter', () => {
  test('refuses an IP past its bucket without spending the machine bucket, and refills over time', () => {
    const { limiter, clock } = setup()
    expect(limiter.admitBrowser('a', 'm')).toEqual({ ok: true })
    expect(limiter.admitBrowser('a', 'm')).toEqual({ ok: true })
    expect(limiter.admitBrowser('a', 'm')).toEqual({ ok: false, retryAfterSeconds: 1 })
    expect(limiter.admitBrowser('a', 'm')).toEqual({ ok: false, retryAfterSeconds: 1 })
    // The machine's bucket still has the one token the refused attempts did not take.
    expect(limiter.admitBrowser('b', 'm')).toEqual({ ok: true })
    expect(limiter.admitBrowser('b', 'm')).toEqual({ ok: false, retryAfterSeconds: 1 })
    expect(limiter.admitBrowser('c', 'other')).toEqual({ ok: true })

    clock.now = 1000
    expect(limiter.admitBrowser('a', 'other')).toEqual({ ok: true })
    expect(limiter.admitTunnel('a')).toEqual({ ok: true })
    expect(limiter.admitTunnel('a')).toEqual({ ok: false, retryAfterSeconds: 10 })
    expect(limiter.admitTunnel('b')).toEqual({ ok: true })
  })

  test('blocks an IP out of bad-key tokens for every machine until a token refills, and no other IP', () => {
    const { limiter, clock } = setup({ perIp: { capacity: 100, refillEveryMs: 1000 } })
    limiter.badKey('a')
    expect(limiter.admitBrowser('a', 'm').ok).toBe(true)
    limiter.badKey('a')
    expect(limiter.admitBrowser('a', 'm')).toEqual({ ok: false, retryAfterSeconds: 60 })
    expect(limiter.admitBrowser('a', 'n')).toEqual({ ok: false, retryAfterSeconds: 60 })
    expect(limiter.admitBrowser('b', 'm').ok).toBe(true)

    clock.now = 30_000
    limiter.badKey('a')
    expect(limiter.admitBrowser('a', 'm')).toEqual({ ok: false, retryAfterSeconds: 30 })
    clock.now = 60_000
    expect(limiter.admitBrowser('a', 'm').ok).toBe(true)
  })

  test('the sweep empties every map once each IP and machine goes idle, and keeps buckets still refilling', () => {
    const { limiter, clock } = setup()
    limiter.admitBrowser('a', 'm')
    limiter.admitBrowser('b', 'n')
    limiter.admitTunnel('a')
    limiter.badKey('c')
    expect(limiter.size).toBe(6)

    clock.now = 10_000
    limiter.sweep()
    expect(limiter.size).toBe(1)
    clock.now = 60_000
    limiter.sweep()
    expect(limiter.size).toBe(0)
  })
})
