import { describe, expect, test } from 'bun:test'
import { createRateLimiter, type RateDecision } from './rateLimit'

function setup() {
  const clock = { t: 0 }
  const limit = createRateLimiter({ now: () => clock.t })
  const send = (count: number) => {
    const seen: Record<RateDecision, number> = { accept: 0, drop: 0, close: 0 }
    for (let i = 0; i < count; i++) seen[limit()]++
    return seen
  }
  return { clock, limit, send }
}

describe('createRateLimiter', () => {
  test('accepts a burst, drops past it, and refills at the rate up to the burst', () => {
    const { clock, limit, send } = setup()
    expect(send(500)).toEqual({ accept: 500, drop: 0, close: 0 })
    expect(limit()).toBe('drop')
    clock.t = 1000
    expect(send(300)).toEqual({ accept: 200, drop: 100, close: 0 })
    clock.t = 60_000
    expect(send(600).accept).toBe(500)
  })

  test('never drops a steady 150 frames per second for a minute', () => {
    const { clock, send } = setup()
    for (let i = 0; i < 150 * 60; i++) {
      clock.t = (i * 1000) / 150
      expect(send(1)).toEqual({ accept: 1, drop: 0, close: 0 })
    }
  })

  test('closes once 1000 frames are dropped within 10 s, not before, and only once', () => {
    const { clock, send } = setup()
    send(500)
    clock.t = 5000
    // 1000 tokens refilled over 5 s, capped at the burst of 500.
    expect(send(500 + 999)).toEqual({ accept: 500, drop: 999, close: 0 })
    expect(send(1)).toEqual({ accept: 0, drop: 0, close: 1 })
    expect(send(10)).toEqual({ accept: 0, drop: 10, close: 0 })
  })

  test('drops spread thinner than 1000 per 10 s never close', () => {
    const { clock, send } = setup()
    send(500)
    // 990 drops every 10 s for a minute: each second is 99 over the 200 refilled.
    for (let s = 1; s <= 60; s++) {
      clock.t = s * 1000
      expect(send(299)).toEqual({ accept: 200, drop: 99, close: 0 })
    }
  })
})
