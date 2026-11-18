import { z } from 'zod'

// Device proofs let a machine admit only browsers its owner approved on the
// machine itself. Each browser keeps a non-exportable P-256 key pair and signs
// a fresh proof for every relayed request and socket, alongside the relay
// ticket, so a ticket the server captured opens nothing on its own. The server never holds a device's private key, so it can't make one.
// A proof is a compact JWS (`header.payload.signature`, base64url, `alg: ES256`).

/** The request header that carries a device proof on HTTP requests. */
export const DEVICE_PROOF_HEADER = 'x-orch-device-proof'

/** How far a proof's `iat` may be from the machine's clock, either way, in seconds. */
export const DEVICE_PROOF_SKEW_SECONDS = 300

/** The `method` a socket's proof signs, in place of an HTTP method. */
export const DEVICE_PROOF_SOCKET_METHOD = 'WS'

/** The close code a browser socket gets when its ticket and proof are valid but the machine hasn't approved the device. */
export const CLOSE_DEVICE_NOT_APPROVED = 4403

/** The error code of the 403 an HTTP request gets for the same reason. */
export const DEVICE_NOT_APPROVED_CODE = 'device_not_approved'

const base64url = (length: number) => z.string().regex(new RegExp(`^[A-Za-z0-9_-]{${length}}$`))

/** A device's public key: a P-256 JWK with only its four public fields. */
export const deviceJwk = z.strictObject({
  kty: z.literal('EC'),
  crv: z.literal('P-256'),
  x: base64url(43),
  y: base64url(43),
})
export type DeviceJwk = z.infer<typeof deviceJwk>

/** A proof's protected header, which carries the device's public key. */
export const deviceProofHeader = z.strictObject({
  alg: z.literal('ES256'),
  typ: z.literal('orch-device'),
  jwk: deviceJwk,
})
export type DeviceProofHeader = z.infer<typeof deviceProofHeader>

/**
 * What a proof signs: one request to machine `aud` at `iat` (Unix seconds),
 * with a random 16-byte `nonce`. `method` is the HTTP method, or `'WS'` for a
 * socket; `path` is the host path with its query string; `bodySha256` is the
 * base64url SHA-256 of the body, or of the empty string.
 */
export const deviceProofPayload = z.strictObject({
  aud: z.string().min(1),
  iat: z.number().int().positive(),
  nonce: base64url(22),
  method: z.string().min(1),
  path: z.string().min(1),
  bodySha256: base64url(43),
})
export type DeviceProofPayload = z.infer<typeof deviceProofPayload>

/**
 * The JSON a device id hashes: the key's `crv`, `kty`, `x` and `y`, in that
 * order, with nothing else. The device id is the base64url SHA-256 of it.
 */
export function canonicalDeviceJwk({ crv, kty, x, y }: DeviceJwk): string {
  return JSON.stringify({ crv, kty, x, y })
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * The short form of a device id's SHA-256 `digest` that people compare: its
 * first 10 bytes as 16 Crockford base32 characters in four groups, such as
 * `ABCD-EFGH-JKMN-PQRS`.
 */
export function deviceFingerprint(digest: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of digest.subarray(0, 10)) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += CROCKFORD[(value >> bits) & 31]
    }
    value &= (1 << bits) - 1
  }
  return out.match(/.{4}/g)?.join('-') ?? out
}

/**
 * A fingerprint as it is compared: trimmed, without dashes or whitespace, and
 * uppercased, so `abcd efgh-jkmn-pqrs` names the same device as `ABCD-EFGH-JKMN-PQRS`.
 */
export function fingerprintKey(typed: string): string {
  return typed
    .trim()
    .replace(/[\s-]+/g, '')
    .toUpperCase()
}

/** How many characters a fingerprint has, without its dashes. */
export const FINGERPRINT_LENGTH = 16

/** The letters and digits of a typed fingerprint, uppercased, up to its full length. */
function fingerprintChars(typed: string): string {
  return typed
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .slice(0, FINGERPRINT_LENGTH)
}

/** Characters grouped in fours with dashes between, as a browser shows a fingerprint. */
function groupFingerprint(chars: string): string {
  return chars.match(/.{1,4}/g)?.join('-') ?? ''
}

/**
 * Formats one edit of a fingerprint field, shaped like the one a browser shows (uppercased, anything but letters and
 * digits dropped, cut at 16 characters and grouped in fours), and says where its caret goes. `previous` is the field's formatted value
 * before the edit, `typed` its raw value after, and `caret` the caret in `typed`. The caret keeps its place among the
 * letters and digits rather than jumping to the end, and Backspace (`backward`) or Delete (`forward`) that removed
 * only a dash removes the character on the other side of it instead, since the dash would come straight back.
 */
export function editFingerprint(
  previous: string,
  typed: string,
  caret: number,
  direction: 'backward' | 'forward' = 'backward',
): { value: string; caret: number } {
  let chars = fingerprintChars(typed)
  // Characters before the caret that are kept, which fixes the caret's place among them.
  let before = fingerprintChars(typed.slice(0, caret)).length
  const removedOneDash =
    typed.length === previous.length - 1 && chars === fingerprintChars(previous) && previous.includes('-')
  if (removedOneDash) {
    if (direction === 'backward' && before > 0) {
      chars = chars.slice(0, before - 1) + chars.slice(before)
      before -= 1
    } else if (direction === 'forward') {
      chars = chars.slice(0, before) + chars.slice(before + 1)
    }
  }
  const value = groupFingerprint(chars)
  // Each full group before the caret adds a dash, but the caret stays before the dash that ends its own group.
  const dashes = before > 0 ? Math.floor((before - 1) / 4) : 0
  return { value, caret: Math.min(before + dashes, value.length) }
}
