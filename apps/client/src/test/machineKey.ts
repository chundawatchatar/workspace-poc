import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { answerBrowserHandshake, machineFingerprint, type OpenE2eSessionResponse } from '@orch/shared'

/**
 * A machine as the browser meets it: a fresh Ed25519 public key, the id it hashes to, that id's fingerprint, and
 * `answer`, which answers a browser's end-to-end hello as the host's `routes.e2e.open` does.
 */
export function testMachine() {
  const { publicKey: publicHalf, privateKey } = generateKeyPairSync('ed25519')
  const publicKey = publicHalf.export({ format: 'jwk' }).x ?? ''
  const id = createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('base64url')
  const machine = { publicKey, sign: async (data: Uint8Array) => new Uint8Array(sign(null, data, privateKey)) }
  const answer = async (hello: unknown): Promise<OpenE2eSessionResponse> => {
    const { reply } = await answerBrowserHandshake({ machineId: id, machine, hello })
    const expiresAt = new Date(Date.now() + 60_000).toISOString()
    return {
      sessionId: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url'),
      hello: reply,
      expiresAt,
    }
  }
  return { publicKey, id, fingerprint: machineFingerprint(id), answer }
}
