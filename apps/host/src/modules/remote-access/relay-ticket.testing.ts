import { generateKeyPairSync, sign } from 'node:crypto'
import type { RelayKey, RelayTicketPayload } from '@orch/shared'

// Test-only helpers that sign relay tickets as the server would. Never imported by production code.

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

/** A fresh Ed25519 key named `kid`: its public `relayKey` and a `ticket` signer. */
export function testRelayKey(kid = 'test-1') {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const x = publicKey.export({ format: 'jwk' }).x ?? ''
  const relayKey: RelayKey = { kid, publicKey: x }
  let next = 0
  /**
   * A ticket for `sub` and `aud` that expires in a minute, with a fresh `jti`,
   * changed by `overrides`. `headerKid` signs it under another key id.
   */
  function ticket(
    { sub, aud, ...overrides }: Pick<RelayTicketPayload, 'sub' | 'aud'> & Partial<RelayTicketPayload>,
    headerKid = kid,
  ): string {
    const jti = `jti${String(++next).padStart(19, '0')}`
    const payload = { sub, aud, exp: Math.floor(Date.now() / 1000) + 60, jti, ...overrides }
    const signingInput = `${encode({ alg: 'EdDSA', typ: 'orch-relay', kid: headerKid })}.${encode(payload)}`
    return `${signingInput}.${sign(null, Buffer.from(signingInput), privateKey).toString('base64url')}`
  }
  return { relayKey, ticket }
}
