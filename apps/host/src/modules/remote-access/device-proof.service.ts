import { createHash, createPublicKey, verify } from 'node:crypto'
import {
  canonicalDeviceJwk,
  DEVICE_PROOF_SKEW_SECONDS,
  type DeviceJwk,
  deviceFingerprint,
  deviceProofHeader,
  deviceProofPayload,
} from '@orch/shared'

/** What a proof must sign to admit one request or socket. `now` is in milliseconds. */
export interface DeviceProofCheck {
  /** This machine's id, which must be the proof's `aud`. */
  machineId: string
  /** The request's HTTP method, or `'WS'` for a socket. */
  method: string
  /** The host path with its query string, as the tunnel delivered it. */
  path: string
  /** The base64url SHA-256 of the request body, or of the empty string. */
  bodySha256: string
  now: number
}

/** A proof that verified: the device it came from, and the nonce to spend. */
export interface VerifiedDeviceProof {
  deviceId: string
  publicKey: DeviceJwk
  nonce: string
  iat: number
}

/** The device id of `jwk`: the base64url SHA-256 of its canonical JSON. */
export function deviceIdOf(jwk: DeviceJwk): string {
  return createHash('sha256').update(canonicalDeviceJwk(jwk)).digest('base64url')
}

/** The fingerprint people compare for a device id, as the browser shows it. */
export function fingerprintOf(deviceId: string): string {
  return deviceFingerprint(Buffer.from(deviceId, 'base64url'))
}

/**
 * The device behind `proof` when it is a compact JWS signed by the P-256 key
 * in its own header, for exactly this machine, method, path and body, with an
 * `iat` within `DEVICE_PROOF_SKEW_SECONDS` of `now`. Null means refused, for
 * any reason. It does not spend the nonce; the caller does.
 */
export function verifyDeviceProof(proof: string, check: DeviceProofCheck): VerifiedDeviceProof | null {
  const parts = proof.split('.')
  if (parts.length !== 3) return null
  const [encodedHeader = '', encodedPayload = '', signature = ''] = parts
  const header = deviceProofHeader.safeParse(decodePart(encodedHeader))
  if (!header.success) return null
  const { jwk } = header.data
  let valid = false
  try {
    const publicKey = createPublicKey({ key: jwk, format: 'jwk' })
    valid = verify(
      'sha256',
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url'),
    )
  } catch {
    return null
  }
  if (!valid) return null
  const payload = deviceProofPayload.safeParse(decodePart(encodedPayload))
  if (!payload.success) return null
  const { aud, iat, nonce, method, path, bodySha256 } = payload.data
  if (aud !== check.machineId || method !== check.method || path !== check.path) return null
  if (bodySha256 !== check.bodySha256) return null
  if (Math.abs(iat - check.now / 1000) > DEVICE_PROOF_SKEW_SECONDS) return null
  return { deviceId: deviceIdOf(jwk), publicKey: jwk, nonce, iat }
}

function decodePart(part: string): unknown {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
  } catch {
    return undefined
  }
}

/**
 * The proof nonces already used, each kept for twice `DEVICE_PROOF_SKEW_SECONDS`,
 * longer than any proof can stay inside the skew, so a proof admits at most
 * one request or socket.
 */
export class SpentNonces {
  private readonly spent = new Map<string, number>()

  /** Spends `nonce` at `now` (milliseconds). False means it was already spent. */
  spend(nonce: string, now: number): boolean {
    const cutoff = now - 2 * DEVICE_PROOF_SKEW_SECONDS * 1000
    for (const [seen, at] of this.spent) {
      if (at > cutoff) break
      this.spent.delete(seen)
    }
    if (this.spent.has(nonce)) return false
    this.spent.set(nonce, now)
    return true
  }
}
