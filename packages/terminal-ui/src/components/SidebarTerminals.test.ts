import { describe, expect, test } from 'bun:test'
import { formatElapsed } from './SidebarTerminals'

describe('formatElapsed', () => {
  test.each([
    [-1000, '0s'],
    [59_999, '59s'],
    [60_000, '1m'],
    [3_600_000, '1h'],
    [3_900_000, '1h 5m'],
    [172_800_000, '2d'],
  ] as const)('%d ms reads %s', (ms, label) => {
    expect(formatElapsed(ms)).toBe(label)
  })
})
