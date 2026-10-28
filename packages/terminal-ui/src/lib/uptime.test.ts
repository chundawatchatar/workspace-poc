import { describe, expect, test } from 'bun:test'
import { formatUptime } from './uptime'

const second = 1000
const minute = 60 * second
const hour = 60 * minute
const day = 24 * hour

describe('formatUptime', () => {
  test('shows at most the two largest units, and seconds only below a minute', () => {
    expect(formatUptime(45 * second)).toBe('45s')
    expect(formatUptime(12 * minute + 30 * second)).toBe('12m')
    expect(formatUptime(2 * hour + 13 * minute + 59 * second)).toBe('2h 13m')
    expect(formatUptime(3 * day + 4 * hour + 5 * minute)).toBe('3d 4h')
  })

  test('keeps a zero second unit so the larger one reads in context', () => {
    expect(formatUptime(2 * hour + 30 * second)).toBe('2h 0m')
    expect(formatUptime(0)).toBe('0s')
  })
})
