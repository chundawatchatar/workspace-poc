import { describe, expect, test } from 'bun:test'
import { answerBrowserHandshake, E2eError, startBrowserHandshake } from './e2e'
import {
  decodeEnvelope,
  decodeRequestRecord,
  decodeResponseRecord,
  encodeEnvelope,
  encodeRequestRecord,
  encodeResponseRecord,
} from './e2eHttp'
import {
  decodeSocketMessageRecord,
  decodeSocketOpenRecord,
  type E2eSocketOpen,
  encodeSocketMessageRecord,
  encodeSocketOpenRecord,
  MAX_E2E_SOCKET_MESSAGE_BYTES,
} from './e2eSocket'
import { machineIdFromPublicKey } from './tunnel'

const sessionId = 'AAECAwQFBgcICQoLDA0ODw'

function fails(run: () => unknown) {
  expect(run).toThrow(E2eError)
}

/** A browser and a machine session from one real handshake. */
async function sessions() {
  const machineKey = (await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify'])) as CryptoKeyPair
  const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', machineKey.publicKey)).toString('base64url')
  const machineId = await machineIdFromPublicKey(publicKey)
  const deviceKey = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
  const device = {
    publicJwk: await crypto.subtle.exportKey('jwk', deviceKey.publicKey),
    sign: async (data: Uint8Array<ArrayBuffer>) =>
      new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, deviceKey.privateKey, data)),
  }
  const machine = {
    publicKey,
    sign: async (data: Uint8Array<ArrayBuffer>) =>
      new Uint8Array(await crypto.subtle.sign('Ed25519', machineKey.privateKey, data)),
  }
  const started = await startBrowserHandshake({ machineId, device })
  const answer = await answerBrowserHandshake({ machineId, machine, hello: started.hello })
  return { browser: await started.finish(answer.reply, publicKey), machine: answer.session }
}

const open: E2eSocketOpen = {
  path: '/ws/term/t1?cols=80',
  auth: { type: 'auth', account: true, device: 'a.proof' },
  ticket: 'a.ticket.sig',
}

describe('sealed socket records', () => {
  test('the open, text and binary records round-trip sealed on a session channel, in order', async () => {
    const { browser, machine } = await sessions()
    const out = await browser.channel(3)
    const envelope = encodeEnvelope({ sessionId, channel: 3, sealed: await out.seal(encodeSocketOpenRecord(open)) })
    const read = decodeEnvelope(envelope)
    const inn = await machine.channel(read.channel)
    expect(decodeSocketOpenRecord(await inn.open(read.sealed))).toEqual(open)

    const messages = ['héllo', Uint8Array.of(0, 1, 255), '', new Uint8Array()]
    const sealed = await Promise.all(messages.map((message) => out.seal(encodeSocketMessageRecord(message))))
    const opened = []
    for (const record of sealed) opened.push(decodeSocketMessageRecord(await inn.open(record)))
    expect(opened).toEqual(messages)
    expect(typeof opened[2]).toBe('string')
    expect(opened[3]).toBeInstanceOf(Uint8Array)

    // The machine's messages come back the other way on the same channel.
    const back = await inn.seal(encodeSocketMessageRecord('ok'))
    expect(decodeSocketMessageRecord(await out.open(back))).toBe('ok')
  })

  test('each record kind is read only as itself, never as another socket or HTTP record', () => {
    const records = {
      open: encodeSocketOpenRecord(open),
      text: encodeSocketMessageRecord('x'),
      binary: encodeSocketMessageRecord(Uint8Array.of(1)),
      request: encodeRequestRecord({ method: 'GET', path: '/api/health', headers: [] }),
      head: encodeResponseRecord({ kind: 'head', head: { status: 200, headers: [] } }),
      body: encodeResponseRecord({ kind: 'body', data: Uint8Array.of(1) }),
      end: encodeResponseRecord({ kind: 'end' }),
    }
    const tags = Object.values(records).map((record) => record[0])
    expect(new Set(tags).size).toBe(tags.length)
    for (const [kind, record] of Object.entries(records)) {
      if (kind !== 'open') fails(() => decodeSocketOpenRecord(record))
      if (kind !== 'text' && kind !== 'binary') fails(() => decodeSocketMessageRecord(record))
      if (kind !== 'request') fails(() => decodeRequestRecord(record))
      if (!['head', 'body', 'end'].includes(kind)) fails(() => decodeResponseRecord(record))
    }
  })

  test('an open record outside /ws/, with a bad auth message or an unknown field is refused, and so is bad text', () => {
    const bad: unknown[] = [
      { ...open, path: '/api/health' },
      { ...open, path: '/wsx' },
      { ...open, auth: { type: 'auth', device: 'p' } },
      { ...open, auth: { type: 'auth', key: '', device: 'p' } },
      { ...open, auth: { type: 'input', data: 'ls' } },
      { ...open, ticket: '' },
      { ...open, headers: [] },
    ]
    for (const record of bad) fails(() => encodeSocketOpenRecord(record as E2eSocketOpen))
    const raw = (value: unknown) => Uint8Array.of(16, ...new TextEncoder().encode(JSON.stringify(value)))
    expect(decodeSocketOpenRecord(raw(open))).toEqual(open)
    for (const record of bad) fails(() => decodeSocketOpenRecord(raw(record)))
    fails(() => decodeSocketOpenRecord(Uint8Array.of(16, 123)))

    fails(() => decodeSocketMessageRecord(Uint8Array.of(17, 0xff)))
    fails(() => decodeSocketMessageRecord(new Uint8Array()))
    fails(() => encodeSocketMessageRecord(new Uint8Array(MAX_E2E_SOCKET_MESSAGE_BYTES + 1)))
    expect(encodeSocketMessageRecord(new Uint8Array(MAX_E2E_SOCKET_MESSAGE_BYTES)).byteLength).toBe(
      MAX_E2E_SOCKET_MESSAGE_BYTES + 1,
    )
  })
})
