import { describe, expect, test } from 'bun:test'
import { canonicalDeviceJwk, deviceFingerprint, fingerprintKey } from './deviceProof'

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

  test('the canonical key has crv, kty, x and y in that order, whatever order it came in', () => {
    const jwk = { y: 'Y', x: 'X', kty: 'EC', crv: 'P-256' } as const
    expect(canonicalDeviceJwk(jwk as never)).toBe('{"crv":"P-256","kty":"EC","x":"X","y":"Y"}')
  })
})
