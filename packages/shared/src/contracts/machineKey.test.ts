import { describe, expect, test } from 'bun:test'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { deviceFingerprint } from './deviceProof'
import { machineFingerprint, machineKeyMatches } from './machineKey'

/** A fresh Ed25519 public key and the id the server derives from it. */
function machine() {
  const publicKey = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x ?? ''
  const digest = createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest()
  return { publicKey, id: digest.toString('base64url'), digest }
}

describe('machine key', () => {
  test('the fingerprint groups the first 10 bytes of the id as a device fingerprint does', () => {
    const { id, digest } = machine()
    expect(machineFingerprint(id)).toBe(deviceFingerprint(new Uint8Array(digest.subarray(0, 10))))
    expect(machineFingerprint(id)).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/)
  })

  test('a key matches only its own id', async () => {
    const [one, other] = [machine(), machine()]
    expect(await machineKeyMatches(one.publicKey, one.id)).toBe(true)
    expect(await machineKeyMatches(other.publicKey, one.id)).toBe(false)
    expect(await machineKeyMatches(one.publicKey, other.id)).toBe(false)
    for (const malformed of ['', 'short', `${one.publicKey}A`, `${one.publicKey.slice(0, -1)}+`]) {
      expect(await machineKeyMatches(malformed, one.id)).toBe(false)
    }
  })
})
