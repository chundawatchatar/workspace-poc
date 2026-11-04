import { DEVICE_PROOF_SOCKET_METHOD, deviceJwk } from '@orch/shared'
import { createDeviceProof, deviceSigner, type ProofTarget } from '@orch/terminal-ui/device-proof'
import { bodySha256, type PresentedProof } from '../tunnel/tunnel-http.service'
import { deviceIdOf } from './device-proof.service'

// Test-only helpers that sign device proofs as a browser would, with the
// browser's own proof builder and a WebCrypto key. Never imported by production code.

/** A fresh browser device key: its id, and builders for its proofs. */
export async function testDevice() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
  const signer = await deviceSigner(pair)
  const { kty, crv, x, y } = signer.publicJwk
  const id = deviceIdOf(deviceJwk.parse({ kty, crv, x, y }))
  /** A proof for `target`, signed at `now` (milliseconds). */
  const proof = (target: ProofTarget, now?: number) => createDeviceProof(signer, target, now)
  /** A proof for `target` as `Credentials.device`, as the tunnel hands it over. */
  const presented = async (target: ProofTarget, now?: number): Promise<PresentedProof> => ({
    proof: await proof(target, now),
    method: target.method,
    path: target.path,
    bodySha256: bodySha256(target.body ?? ''),
  })
  /** A socket's proof for `path`. */
  const socket = (machineId: string, path: string) => proof({ machineId, method: DEVICE_PROOF_SOCKET_METHOD, path })
  return { id, signer, proof, presented, socket }
}
