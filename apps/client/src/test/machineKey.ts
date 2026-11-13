import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import {
  answerBrowserHandshake,
  decodeEnvelope,
  decodeSocketOpenRecord,
  type E2eSession,
  type E2eSocketOpen,
  machineFingerprint,
  type OpenE2eSessionResponse,
} from '@orch/shared'

/**
 * A machine as the browser meets it: a fresh Ed25519 public key, the id it hashes to, that id's fingerprint,
 * `answer`, which answers a browser's end-to-end hello as the host's `routes.e2e.open` does, and `openSocket`, which
 * reads a sealed socket's first message, its envelope, as the host does.
 */
export function testMachine() {
  const { publicKey: publicHalf, privateKey } = generateKeyPairSync('ed25519')
  const publicKey = publicHalf.export({ format: 'jwk' }).x ?? ''
  const id = createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('base64url')
  const machine = { publicKey, sign: async (data: Uint8Array) => new Uint8Array(sign(null, data, privateKey)) }
  const answer = async (hello: unknown): Promise<OpenE2eSessionResponse> => {
    const { reply, session } = await answerBrowserHandshake({ machineId: id, machine, hello })
    const expiresAt = new Date(Date.now() + 60_000).toISOString()
    const sessionId = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url')
    sessions.set(sessionId, session)
    return { sessionId, hello: reply, expiresAt }
  }
  const sessions = new Map<string, E2eSession>()
  /** The open record in a sealed socket's envelope, which arrives as an `ArrayBuffer` or a `Blob`. */
  const openSocket = async (data: unknown): Promise<E2eSocketOpen> => {
    const bytes = data instanceof Blob ? await data.arrayBuffer() : (data as ArrayBuffer)
    const envelope = decodeEnvelope(new Uint8Array(bytes))
    const session = sessions.get(envelope.sessionId)
    if (!session) throw new Error('no such session')
    const channel = await session.channel(envelope.channel)
    return decodeSocketOpenRecord(await channel.open(envelope.sealed))
  }
  return { publicKey, id, fingerprint: machineFingerprint(id), answer, openSocket }
}
