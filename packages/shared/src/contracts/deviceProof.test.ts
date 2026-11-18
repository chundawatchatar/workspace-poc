import { describe, expect, test } from 'bun:test'
import { canonicalDeviceJwk, deviceFingerprint, editFingerprint, fingerprintKey } from './deviceProof'

/** The field's value after typing `text` into an empty field, caret at the end. */
const typedAtEnd = (text: string) => editFingerprint('', text, text.length).value

describe('device identity', () => {
  test('the fingerprint is the first 10 bytes in Crockford base32, in four groups', () => {
    const digest = new Uint8Array(32)
    digest.set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    digest.fill(0xff, 10)
    expect(deviceFingerprint(digest)).toBe('0410-6105-0R3G-G28A')
    expect(deviceFingerprint(new Uint8Array(32).fill(0xff))).toBe('ZZZZ-ZZZZ-ZZZZ-ZZZZ')
  })

  test('a typed fingerprint compares without case, dashes or whitespace', () => {
    for (const typed of [
      'ABCD-EFGH-JKMN-PQRS',
      '  abcd-efgh-jkmn-pqrs\n',
      'abcdefghjkmnpqrs',
      'ABCD EFGH\tJKMN--PQRS',
    ]) {
      expect(fingerprintKey(typed)).toBe('ABCDEFGHJKMNPQRS')
    }
    expect(fingerprintKey(' - ')).toBe('')
  })

  test('a fingerprint being typed is uppercased, grouped in fours and cut at 16 characters', () => {
    expect(typedAtEnd('qpz91cdy t8')).toBe('QPZ9-1CDY-T8')
    expect(typedAtEnd('QPZ9-')).toBe('QPZ9')
    expect(typedAtEnd(' qpz9-1cdy-t85e-tk7d-extra')).toBe('QPZ9-1CDY-T85E-TK7D')
    expect(typedAtEnd(' - ')).toBe('')
  })

  test('an edit keeps the caret among the characters, and deleting a dash deletes the character beyond it', () => {
    const full = 'AAAA-BBBB-CCCC-DDDD'
    // Backspace just after the first dash removes the last A, not just the dash, and the caret stays there.
    expect(editFingerprint(full, 'AAAABBBB-CCCC-DDDD', 4)).toEqual({ value: 'AAAB-BBBC-CCCD-DDD', caret: 3 })
    // Delete just before it removes the first B.
    expect(editFingerprint(full, 'AAAABBBB-CCCC-DDDD', 4, 'forward')).toEqual({ value: 'AAAA-BBBC-CCCD-DDD', caret: 4 })
    // Typing in the middle keeps the caret after the new character, not at the end.
    expect(editFingerprint('AAAA-BBBB', 'AAXAA-BBBB', 3)).toEqual({ value: 'AAXA-ABBB-B', caret: 3 })
    // Typing at the end of a group steps over the dash it adds.
    expect(editFingerprint('AAAA', 'AAAAB', 5)).toEqual({ value: 'AAAA-B', caret: 6 })
    // Backspace inside a group works as usual.
    expect(editFingerprint('AAAA-BBBB', 'AAAA-BBB', 8)).toEqual({ value: 'AAAA-BBB', caret: 8 })
  })

  test('the canonical key has crv, kty, x and y in that order, whatever order it came in', () => {
    const jwk = { y: 'Y', x: 'X', kty: 'EC', crv: 'P-256' } as const
    expect(canonicalDeviceJwk(jwk as never)).toBe('{"crv":"P-256","kty":"EC","x":"X","y":"Y"}')
  })
})
