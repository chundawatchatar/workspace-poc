import { describe, expect, test } from 'bun:test'
import { formatLocalDateTime, formatTimeLeft } from './datetime'

describe('formatLocalDateTime', () => {
  test('formats strings, timestamps and dates the same way', () => {
    const iso = '2026-11-02T15:04:00.000Z'
    const expected = new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    expect(formatLocalDateTime(iso)).toBe(expected)
    expect(formatLocalDateTime(Date.parse(iso))).toBe(expected)
    expect(formatLocalDateTime(new Date(iso))).toBe(expected)
  })

  test('gives an empty string, not "Invalid Date", for a bad value', () => {
    expect(formatLocalDateTime('not a date')).toBe('')
  })
})

describe('formatTimeLeft', () => {
  test('gives mm:ss rounded up to the second, and never below 00:00', () => {
    expect(formatTimeLeft(15 * 60_000)).toBe('15:00')
    expect(formatTimeLeft(14 * 60_000 + 59_001)).toBe('15:00')
    expect(formatTimeLeft(61_000)).toBe('01:01')
    expect(formatTimeLeft(1)).toBe('00:01')
    expect(formatTimeLeft(0)).toBe('00:00')
    expect(formatTimeLeft(-5000)).toBe('00:00')
  })
})
