import { createHash, generateKeyPairSync } from 'node:crypto'
import { machineFingerprint } from '@orch/shared'

/** A machine as the browser meets it: a fresh Ed25519 public key, the id it hashes to, and that id's fingerprint. */
export function testMachine() {
  const publicKey = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x ?? ''
  const id = createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('base64url')
  return { publicKey, id, fingerprint: machineFingerprint(id) }
}
