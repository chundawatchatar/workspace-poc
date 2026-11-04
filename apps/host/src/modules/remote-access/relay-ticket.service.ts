import { createPublicKey, verify } from 'node:crypto'
import {
  RELAY_TICKET_TTL_SECONDS,
  type RelayKey,
  type RelayTicketPayload,
  relayTicketHeader,
  relayTicketPayload,
} from '@orch/shared'

/** How far the server's clock may run behind this machine's before its tickets count as expired, in seconds. */
export const RELAY_TICKET_SKEW_SECONDS = 30

/** What a ticket must match to open this machine. `now` is in milliseconds. */
export interface RelayTicketCheck {
  /** The server's public keys this machine saved when it linked. */
  keys: readonly RelayKey[]
  /** This machine's id, which must be the ticket's `aud`. */
  machineId: string
  /** The linked account's user id, which must be the ticket's `sub`. */
  accountId: string
  now: number
}

/**
 * The payload of `ticket` when it is a compact JWS signed with one of `keys`
 * (by its `kid`) for this machine and the linked account, and not expired
 * beyond `RELAY_TICKET_SKEW_SECONDS`. A ticket that claims to live longer
 * than a fresh one could is refused too. Null means refused, for any reason.
 */
export function verifyRelayTicket(ticket: string, check: RelayTicketCheck): RelayTicketPayload | null {
  const parts = ticket.split('.')
  if (parts.length !== 3) return null
  const [encodedHeader = '', encodedPayload = '', signature = ''] = parts
  const header = relayTicketHeader.safeParse(decodePart(encodedHeader))
  if (!header.success) return null
  const key = check.keys.find((candidate) => candidate.kid === header.data.kid)
  if (!key) return null
  let valid = false
  try {
    const publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key.publicKey }, format: 'jwk' })
    const signed = Buffer.from(`${encodedHeader}.${encodedPayload}`)
    valid = verify(null, signed, publicKey, Buffer.from(signature, 'base64url'))
  } catch {
    return null
  }
  if (!valid) return null
  const payload = relayTicketPayload.safeParse(decodePart(encodedPayload))
  if (!payload.success) return null
  const { sub, aud, exp } = payload.data
  const now = check.now / 1000
  if (aud !== check.machineId || sub !== check.accountId) return null
  if (exp <= now - RELAY_TICKET_SKEW_SECONDS) return null
  if (exp > now + RELAY_TICKET_TTL_SECONDS + RELAY_TICKET_SKEW_SECONDS) return null
  return payload.data
}

function decodePart(part: string): unknown {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
  } catch {
    return undefined
  }
}

/**
 * The ticket ids sockets have opened with, kept until their tickets expire,
 * so a ticket opens at most one socket. HTTP requests may reuse a ticket.
 */
export class SpentTickets {
  private readonly spent = new Map<string, number>()

  /** Spends `payload`'s `jti` at `now` (milliseconds). False means it was already spent. */
  spend(payload: RelayTicketPayload, now: number): boolean {
    const cutoff = now / 1000 - RELAY_TICKET_SKEW_SECONDS
    for (const [jti, exp] of this.spent) if (exp <= cutoff) this.spent.delete(jti)
    if (this.spent.has(payload.jti)) return false
    this.spent.set(payload.jti, payload.exp)
    return true
  }
}
