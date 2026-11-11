import { generateKeyPairSync, sign } from 'node:crypto'
import {
  decodeFrame,
  encodeFrame,
  helloSignedMessage,
  type MachineFrame,
  machineIdFromPublicKey,
  serverFrame,
  TUNNEL_PROTOCOL_VERSION,
} from '@orch/shared'

// Test-only machine keys and `hello` frames for the server's tunnel tests.
// Never imported by production code.

/** A test machine's Ed25519 key, its id, and the `hello` it answers a challenge with. */
export interface TestMachineKey {
  /** The raw public key, unpadded base64url. */
  publicKey: string
  /** The raw private key, unpadded base64url, so a test can look for it where it must never be. */
  privateKey: string
  machineId: string
  /** A version-2 `hello` signed over `nonce`. */
  hello(nonce: string): Extract<MachineFrame, { type: 'hello' }>
}

/** A fresh machine key. */
export async function createTestMachineKey(): Promise<TestMachineKey> {
  const { privateKey } = generateKeyPairSync('ed25519')
  const jwk = privateKey.export({ format: 'jwk' })
  const publicKey = jwk.x ?? ''
  return {
    publicKey,
    privateKey: jwk.d ?? '',
    machineId: await machineIdFromPublicKey(publicKey),
    hello: (nonce) => ({
      type: 'hello',
      version: TUNNEL_PROTOCOL_VERSION,
      publicKey,
      signature: sign(null, helloSignedMessage(nonce), privateKey).toString('base64url'),
    }),
  }
}

/**
 * Answers the server's `challenge` on `ws` with `key`'s signed `hello`, as a
 * host does. Call it before the socket opens, so the challenge is not missed.
 */
export function answerChallenge(ws: WebSocket, key: TestMachineKey): void {
  const onMessage = (event: MessageEvent) => {
    const frame = decodeFrame(serverFrame, event.data)
    if (frame?.type !== 'challenge') return
    ws.removeEventListener('message', onMessage)
    ws.send(encodeFrame(key.hello(frame.nonce)))
  }
  ws.addEventListener('message', onMessage)
}
