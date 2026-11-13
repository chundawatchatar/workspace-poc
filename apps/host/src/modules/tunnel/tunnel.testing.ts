import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import {
  answerBrowserHandshake,
  decodeResponseRecord,
  type E2eChannel,
  type E2eHttpRequest,
  type E2eHttpResponseRecord,
  type E2eSession,
  encodeEnvelope,
  encodeRequestRecord,
  type helloFrame,
  helloSignedMessage,
  RecordFramer,
  startBrowserHandshake,
} from '@orch/shared'
import type { z } from 'zod'
import type { MachineKey } from './tunnel.repository'

/**
 * A machine key held in memory, for tests. `privateKey` is the raw private
 * key, so a test can look for leaks, and `pem` the file `loadOrCreateMachineKey` reads.
 */
export interface TestMachineKey extends MachineKey {
  readonly privateKey: string
  readonly pem: string
}

/** A fresh Ed25519 machine key that never touches the disk. */
export function createTestMachineKey(): TestMachineKey {
  const { privateKey } = generateKeyPairSync('ed25519')
  const jwk = privateKey.export({ format: 'jwk' })
  const publicKey = jwk.x ?? ''
  return {
    publicKey,
    privateKey: jwk.d ?? '',
    pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    machineId: createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('base64url'),
    sign: (message) => sign(null, message, privateKey).toString('base64url'),
  }
}

/** A fresh `challenge` nonce, as a fake server sends it. */
export function testNonce(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
}

/** True when `hello` is signed over `nonce` by the key it names, as the real server checks it. */
export function helloVerifies(hello: z.infer<typeof helloFrame>, nonce: string): boolean {
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: hello.publicKey }, format: 'jwk' })
  return verify(null, helloSignedMessage(nonce), key, Buffer.from(hello.signature, 'base64url'))
}

/** A browser and a machine session from one real handshake with `key`, as the browser and `E2eSessions` hold them. */
export async function testE2ePair(key: MachineKey = createTestMachineKey()) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
  const device = {
    publicJwk: await crypto.subtle.exportKey('jwk', pair.publicKey),
    sign: async (data: Uint8Array<ArrayBuffer>) =>
      new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, data)),
  }
  const machine = {
    publicKey: key.publicKey,
    sign: async (data: Uint8Array) => new Uint8Array(Buffer.from(key.sign(data), 'base64url')),
  }
  const started = await startBrowserHandshake({ machineId: key.machineId, device })
  const answer = await answerBrowserHandshake({ machineId: key.machineId, machine, hello: started.hello })
  return { browser: await started.finish(answer.reply, key.publicKey), machine: answer.session }
}

/** A sealed request's envelope, as the browser posts it: `request` sealed on channel `n` of `session`. */
export async function sealedEnvelope(session: E2eSession, sessionId: string, n: number, request: E2eHttpRequest) {
  const channel = await session.channel(n)
  const data = encodeEnvelope({ sessionId, channel: n, sealed: await channel.seal(encodeRequestRecord(request)) })
  return { channel, data }
}

/**
 * Opens a sealed reply as the browser does: the outer `http.body` payloads, split into records and opened in order on
 * `channel`. Throws `E2eError` for a record that doesn't open.
 */
export async function openSealedReply(channel: E2eChannel, payloads: Uint8Array[]) {
  const framer = new RecordFramer()
  const records: E2eHttpResponseRecord[] = []
  for (const payload of payloads) {
    for (const sealed of framer.push(payload)) records.push(decodeResponseRecord(await channel.open(sealed)))
  }
  const head = records[0]?.kind === 'head' ? records[0].head : null
  const chunks = records.flatMap((record) => (record.kind === 'body' ? [record.data] : []))
  return {
    records,
    status: head?.status,
    headers: head?.headers ?? [],
    chunks: chunks.length,
    body: Buffer.concat(chunks).toString(),
    end: records.at(-1),
  }
}
