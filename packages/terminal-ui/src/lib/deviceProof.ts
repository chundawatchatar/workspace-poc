import {
  canonicalDeviceJwk,
  type DeviceJwk,
  type DeviceProofHeader,
  type DeviceProofPayload,
  deviceFingerprint,
  deviceJwk,
} from '@orch/shared'

/**
 * A browser's device key, as the transport uses it: the public half as a JWK,
 * and a signer that answers a raw (IEEE P1363) ECDSA P-256 / SHA-256 signature.
 * The private half stays with whoever made it, so the page can't read it.
 */
export interface DeviceSigner {
  publicJwk: JsonWebKey
  sign(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array>
}

/** The one request a proof is for. `body` is a string body, if any. */
export interface ProofTarget {
  machineId: string
  /** The HTTP method, or `'WS'` for a socket. */
  method: string
  /** The host path with its query string, as the transport receives it. */
  path: string
  body?: string
}

const encoder = new TextEncoder()

/** `bytes` as unpadded base64url. */
export function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function sha256(data: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(data)))
}

/** The public key's four fields, or a throw when it isn't a P-256 key. */
function publicKeyOf({ kty, crv, x, y }: JsonWebKey): DeviceJwk {
  return deviceJwk.parse({ kty, crv, x, y })
}

/** The fingerprint the machine shows for this key, such as `ABCD-EFGH-JKMN-PQRS`, for the user to compare. */
export async function deviceKeyFingerprint(publicJwk: JsonWebKey): Promise<string> {
  return deviceFingerprint(await sha256(canonicalDeviceJwk(publicKeyOf(publicJwk))))
}

/**
 * A fresh device proof for one request or socket: a compact JWS whose header
 * carries the public key, and whose payload names the machine, the method,
 * the path and the body's SHA-256, with `iat` from `now` (milliseconds) and a
 * random 16-byte nonce.
 */
export async function createDeviceProof(signer: DeviceSigner, target: ProofTarget, now = Date.now()): Promise<string> {
  const header: DeviceProofHeader = { alg: 'ES256', typ: 'orch-device', jwk: publicKeyOf(signer.publicJwk) }
  const payload: DeviceProofPayload = {
    aud: target.machineId,
    iat: Math.floor(now / 1000),
    nonce: base64url(crypto.getRandomValues(new Uint8Array(16))),
    method: target.method,
    path: target.path,
    bodySha256: base64url(await sha256(target.body ?? '')),
  }
  const part = (value: unknown) => base64url(encoder.encode(JSON.stringify(value)))
  const signingInput = `${part(header)}.${part(payload)}`
  return `${signingInput}.${base64url(await signer.sign(encoder.encode(signingInput)))}`
}

/** A signer over a WebCrypto ECDSA P-256 key pair. The private key is used where it is, never exported. */
export async function deviceSigner({ publicKey, privateKey }: CryptoKeyPair): Promise<DeviceSigner> {
  return {
    publicJwk: await crypto.subtle.exportKey('jwk', publicKey),
    sign: async (data) =>
      new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, data)),
  }
}
