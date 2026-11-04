import { createPrivateKey, createPublicKey, type KeyObject, sign } from 'node:crypto'
import {
  RELAY_TICKET_TTL_SECONDS,
  type RelayKey,
  type RelayTicketHeader,
  type RelayTicketPayload,
  type RelayTicketResponse,
} from '@orch/shared'

/** The server's relay signing key from `RELAY_SIGNING_KEY`: a key id and a 32-byte Ed25519 seed. Never log `seed`. */
export interface RelaySigningKey {
  kid: string
  /** The raw 32-byte Ed25519 private seed, unpadded base64url. */
  seed: string
}

// The DER prefix of a PKCS#8 Ed25519 private key; the 32-byte seed follows it.
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

/** The Ed25519 private key for a 32-byte seed. Throws when the seed is not 32 bytes. */
export function relayPrivateKey(seed: string): KeyObject {
  const raw = Buffer.from(seed, 'base64url')
  if (raw.byteLength !== 32) throw new Error('a relay signing key seed must be 32 bytes')
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, raw]), format: 'der', type: 'pkcs8' })
}

/** The public half of `key`, as the raw 32 bytes in unpadded base64url. */
export function relayPublicKey(key: KeyObject): string {
  const jwk = createPublicKey(key).export({ format: 'jwk' })
  if (typeof jwk.x !== 'string') throw new Error('not an Ed25519 key')
  return jwk.x
}

/** A new signing key in `RELAY_SIGNING_KEY` form, `<kid>:<seed>`, with its public key. */
export function generateRelaySigningKey(kid: string): { value: string; publicKey: string } {
  const seed = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
  return { value: `${kid}:${seed}`, publicKey: relayPublicKey(relayPrivateKey(seed)) }
}

/** What the signer is built from. */
export interface RelayTicketsDeps {
  signingKey: RelaySigningKey
  /** Public keys the server will rotate to (`RELAY_EXTRA_PUBLIC_KEYS`), handed to machines with the current one. */
  extraPublicKeys?: readonly RelayKey[]
  /** The clock. Defaults to the current time. */
  now?: () => Date
}

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

/**
 * Signs relay tickets with the server's Ed25519 key. A ticket says that
 * account `sub` may open machine `aud` for `RELAY_TICKET_TTL_SECONDS`; it is a
 * compact JWS with `alg: EdDSA` and the key's `kid`. Nothing here logs a ticket.
 */
export class RelayTickets {
  private readonly key: KeyObject
  private readonly now: () => Date
  /** The public keys machines learn when they link: the current key first, then the extra ones. */
  readonly publicKeys: RelayKey[]

  constructor(private readonly deps: RelayTicketsDeps) {
    this.key = relayPrivateKey(deps.signingKey.seed)
    this.now = deps.now ?? (() => new Date())
    this.publicKeys = [
      { kid: deps.signingKey.kid, publicKey: relayPublicKey(this.key) },
      ...(deps.extraPublicKeys ?? []).filter((extra) => extra.kid !== deps.signingKey.kid),
    ]
  }

  /** A ticket that lets `accountId` open `machineId` for the next 60 seconds. */
  issue(accountId: string, machineId: string): RelayTicketResponse {
    const exp = Math.floor(this.now().getTime() / 1000) + RELAY_TICKET_TTL_SECONDS
    const jti = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url')
    const header: RelayTicketHeader = { alg: 'EdDSA', typ: 'orch-relay', kid: this.deps.signingKey.kid }
    const payload: RelayTicketPayload = { sub: accountId, aud: machineId, exp, jti }
    const signingInput = `${encode(header)}.${encode(payload)}`
    const signature = sign(null, Buffer.from(signingInput), this.key).toString('base64url')
    return { ticket: `${signingInput}.${signature}`, expiresAt: new Date(exp * 1000).toISOString() }
  }
}
