import { z } from 'zod'

// Relay tickets let a signed-in account open a machine without its access key.
// The server signs one for a machine the account lists; the browser sends it
// with a relayed request or socket; the machine checks the signature against
// the public keys it got when it was linked. A ticket is a compact JWS
// (`header.payload.signature`, base64url, `alg: EdDSA`), never in a URL.

/** The request header that carries a relay ticket on HTTP requests. */
export const RELAY_TICKET_HEADER = 'x-orch-relay-ticket'

/**
 * The subprotocol a ticket socket offers first. The server echoes it, since a
 * browser fails a socket whose server picks none of the offered subprotocols.
 */
export const RELAY_SOCKET_PROTOCOL = 'orch.relay'

/** The prefix of the subprotocol that carries a socket's ticket, after `RELAY_SOCKET_PROTOCOL`. */
export const RELAY_TICKET_PROTOCOL_PREFIX = 'orch.ticket.'

/** How long a ticket works after it is issued. */
export const RELAY_TICKET_TTL_SECONDS = 60

const base64url = (length: number) => z.string().regex(new RegExp(`^[A-Za-z0-9_-]{${length}}$`))

/** A key id: names one of the server's signing keys, so a key can be rotated. */
export const relayKeyId = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/)

/** One of the server's public keys: a raw 32-byte Ed25519 key as unpadded base64url. */
export const relayKey = z.strictObject({ kid: relayKeyId, publicKey: base64url(43) })
export type RelayKey = z.infer<typeof relayKey>

/** The public keys a machine trusts tickets from: the server's current key, and any it will rotate to. */
export const relayKeyList = z.array(relayKey).min(1).max(8)

/** A ticket's protected header. */
export const relayTicketHeader = z.strictObject({
  alg: z.literal('EdDSA'),
  typ: z.literal('orch-relay'),
  kid: relayKeyId,
})
export type RelayTicketHeader = z.infer<typeof relayTicketHeader>

/**
 * What a ticket says: account `sub` may open machine `aud` until `exp` (Unix
 * seconds). `jti` is unique per ticket, so a machine can refuse a replayed one.
 */
export const relayTicketPayload = z.strictObject({
  sub: z.string().min(1),
  aud: z.string().min(1),
  exp: z.number().int().positive(),
  jti: base64url(22),
})
export type RelayTicketPayload = z.infer<typeof relayTicketPayload>

/** A ticket as the server answers it. `expiresAt` is an ISO string, for the browser's cache. */
export const relayTicketResponse = z.object({ ticket: z.string().min(1), expiresAt: z.iso.datetime() })
export type RelayTicketResponse = z.infer<typeof relayTicketResponse>

/** The subprotocols a socket opened with `ticket` offers, in order. */
export function relaySocketProtocols(ticket: string): string[] {
  return [RELAY_SOCKET_PROTOCOL, `${RELAY_TICKET_PROTOCOL_PREFIX}${ticket}`]
}

/** The ticket in a `Sec-WebSocket-Protocol` header value, or null when there is none or more than one. */
export function ticketFromProtocols(header: string | undefined): string | null {
  const tickets = (header ?? '')
    .split(',')
    .map((protocol) => protocol.trim())
    .filter((protocol) => protocol.startsWith(RELAY_TICKET_PROTOCOL_PREFIX))
  return tickets.length === 1 ? (tickets[0]?.slice(RELAY_TICKET_PROTOCOL_PREFIX.length) ?? null) : null
}
