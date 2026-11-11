import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { type helloFrame, helloSignedMessage } from '@orch/shared'
import type { z } from 'zod'
import type { MachineKey } from './tunnel.repository'

/**
 * A machine key held in memory, for tests. `privateKey` is the raw private
 * key, so a test can look for leaks, and `pem` the file `loadOrCreateMachineKey` reads.
 */
export interface TestMachineKey extends MachineKey {
  readonly privateKey: string
  readonly pem: string
}

/** A fresh Ed25519 machine key that never touches the disk. */
export function createTestMachineKey(): TestMachineKey {
  const { privateKey } = generateKeyPairSync('ed25519')
  const jwk = privateKey.export({ format: 'jwk' })
  const publicKey = jwk.x ?? ''
  return {
    publicKey,
    privateKey: jwk.d ?? '',
    pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    machineId: createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('base64url'),
    sign: (message) => sign(null, message, privateKey).toString('base64url'),
  }
}

/** A fresh `challenge` nonce, as a fake server sends it. */
export function testNonce(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
}

/** True when `hello` is signed over `nonce` by the key it names, as the real server checks it. */
export function helloVerifies(hello: z.infer<typeof helloFrame>, nonce: string): boolean {
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: hello.publicKey }, format: 'jwk' })
  return verify(null, helloSignedMessage(nonce), key, Buffer.from(hello.signature, 'base64url'))
}
