import { describe, expect, test } from 'bun:test'
import { formatLocalDateTime } from './datetime'

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
