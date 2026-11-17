import { describe, expect, test } from 'bun:test'
import {
  decodeFrame,
  encodeFrame,
  helloSignedMessage,
  MAX_TUNNEL_FRAME_BYTES,
  machineFrame,
  machineIdFromPublicKey,
  parseServerUrl,
  sameServerUrl,
  serverFrame,
  TUNNEL_PATH,
  TUNNEL_PROTOCOL_VERSION,
  type TunnelFrame,
  wsPayloadBytes,
} from './tunnel'

const publicKey = `${'A'.repeat(42)}w`
const signature = `${'B'.repeat(85)}w`
const nonce = `${'C'.repeat(42)}w`
const allBytes = Uint8Array.from({ length: 256 }, (_, i) => i)

/** A binary frame built by hand: `header` as the JSON header, then `payload`. */
function binary(header: unknown, payload = new Uint8Array(), headerLength?: number) {
  const json = new TextEncoder().encode(JSON.stringify(header))
  const out = new Uint8Array(4 + json.byteLength + payload.byteLength)
  new DataView(out.buffer).setUint32(0, headerLength ?? json.byteLength)
  out.set(json, 4)
  out.set(payload, 4 + json.byteLength)
  return out
}

describe('tunnel frames', () => {
  test('every frame round-trips through its direction union, as text unless it carries bytes', () => {
    const machine: TunnelFrame[] = [
      { type: 'hello', version: 3, publicKey, signature },
      {
        type: 'http.response',
        id: 1,
        status: 200,
        headers: [
          ['set-cookie', 'a=1'],
          ['set-cookie', 'b=2'],
        ],
      },
      { type: 'http.body', id: 1, data: allBytes },
      { type: 'http.end', id: 1 },
      { type: 'http.end', id: 2, error: 'stream failed' },
      { type: 'auth.failed', id: 3 },
      { type: 'auth.failed', channel: 7 },
      { type: 'enroll.redeem', id: 6, key: 'not even a key', email: 'not an email', name: 'Laptop' },
      { type: 'unlink', id: 8, accountId: 'u1' },
    ]
    const server: TunnelFrame[] = [
      { type: 'challenge', nonce },
      { type: 'welcome', machineId: 'm-1' },
      { type: 'http.request', id: 3, method: 'GET', path: '/api/git/status?cwd=%2Ftmp', headers: [] },
      { type: 'http.request', id: 4, method: 'POST', path: '/api/fs/dirs', headers: [['x', 'y']], body: allBytes },
      { type: 'http.sealed', id: 5, data: allBytes },
      { type: 'ws.open', channel: 1, path: '/ws/term/abc?cols=80', headers: [] },
      { type: 'ws.sealed', channel: 2, data: allBytes },
      {
        type: 'enroll.redeemed',
        id: 6,
        machineId: 'm-1',
        accountId: 'u1',
        account: { name: 'Alice', maskedEmail: 'a***@example.com' },
        relayKeys: [{ kid: 'k1', publicKey: 'P'.repeat(43) }],
      },
      { type: 'enroll.failed', id: 7, code: 'invalid_key' },
      { type: 'unlinked', id: 8 },
      { type: 'unlink.failed', id: 9, code: 'rate_limited' },
    ]
    const both: TunnelFrame[] = [
      { type: 'ws.data', channel: 1, data: 'héllo' },
      { type: 'ws.data', channel: 1, data: allBytes },
      { type: 'ws.close', channel: 1 },
      { type: 'ws.close', channel: 1, code: 1000, reason: 'bye' },
      { type: 'ws.ack', channel: 1, bytes: 4096 },
      { type: 'ping', nonce: 7 },
      { type: 'pong', nonce: 7 },
    ]
    const check = (frames: TunnelFrame[], schema: typeof machineFrame | typeof serverFrame) => {
      for (const frame of frames) {
        const encoded = encodeFrame(frame)
        const hasBytes = Object.values(frame).some((value) => value instanceof Uint8Array)
        expect(encoded instanceof Uint8Array).toBe(hasBytes)
        if (!hasBytes) expect(typeof encoded).toBe('string')
        expect(decodeFrame(schema, encoded)).toEqual(frame)
      }
    }
    check([...machine, ...both], machineFrame)
    check([...server, ...both], serverFrame)
  })

  test('the protocol is at version 5, and ws.sealed goes as a binary frame whose data decodes byte-equal', () => {
    expect(TUNNEL_PROTOCOL_VERSION).toBe(5)
    const encoded = encodeFrame({ type: 'ws.sealed', channel: 9, data: allBytes })
    expect(encoded).toBeInstanceOf(Uint8Array)
    const decoded = decodeFrame(serverFrame, encoded)
    expect(decoded?.type === 'ws.sealed' && [...decoded.data]).toEqual([...allBytes])
    // Only the server sends it.
    expect(decodeFrame(machineFrame, encoded)).toBeNull()
  })

  test('byte payloads stay raw bytes, and text ws.data stays a string', () => {
    for (const payload of [allBytes, new Uint8Array()]) {
      for (const frame of [
        { type: 'http.body', id: 1, data: payload },
        { type: 'ws.data', channel: 1, data: payload },
      ] as const) {
        const encoded = encodeFrame(frame) as Uint8Array
        const header = JSON.stringify({ ...frame, data: undefined })
        expect(encoded.byteLength).toBe(4 + header.length + payload.byteLength)
        const decoded = decodeFrame(machineFrame, encoded) as { data: unknown }
        expect(decoded.data).toBeInstanceOf(Uint8Array)
        expect(decoded.data).toEqual(payload)
      }
    }
    const text = decodeFrame(serverFrame, encodeFrame({ type: 'ws.data', channel: 2, data: 'abc' }))
    expect(text).toEqual({ type: 'ws.data', channel: 2, data: 'abc' })
  })

  test('a binary frame decodes the same from a Uint8Array, a Buffer, an ArrayBuffer and an offset view', () => {
    const frame = { type: 'http.body', id: 9, data: allBytes } as const
    const encoded = encodeFrame(frame) as Uint8Array
    const larger = new Uint8Array(encoded.byteLength + 20)
    larger.set(encoded, 13)
    const inputs = [encoded, Buffer.from(encoded), encoded.slice().buffer, larger.subarray(13, 13 + encoded.byteLength)]
    for (const input of inputs) expect(decodeFrame(machineFrame, input)).toEqual(frame)
  })

  test('malformed, misdirected, out-of-schema and oversized input decodes to null', () => {
    const bad: [typeof machineFrame | typeof serverFrame, unknown][] = [
      [machineFrame, 'not json'],
      [machineFrame, '{"type":"nope"}'],
      [serverFrame, JSON.stringify({ type: 'hello', version: 2, publicKey, signature })],
      [machineFrame, JSON.stringify({ type: 'welcome', machineId: 'm' })],
      [machineFrame, JSON.stringify({ type: 'challenge', nonce })],
      [serverFrame, JSON.stringify({ type: 'challenge', nonce: 'short' })],
      [machineFrame, JSON.stringify({ type: 'hello', version: 1, proof: publicKey })],
      [machineFrame, JSON.stringify({ type: 'hello', version: 2, publicKey: 'short', signature })],
      [machineFrame, JSON.stringify({ type: 'hello', version: 2, publicKey, signature: `${signature.slice(1)}+` })],
      [machineFrame, JSON.stringify({ type: 'hello', version: 1.5, publicKey, signature })],
      [serverFrame, JSON.stringify({ type: 'http.request', id: 1, method: 'GET', path: '/health', headers: [] })],
      [serverFrame, JSON.stringify({ type: 'http.request', id: 1, method: 'GET', path: '/apix/a', headers: [] })],
      [serverFrame, JSON.stringify({ type: 'ws.open', channel: 1, path: '/api/x', headers: [] })],
      [machineFrame, JSON.stringify({ type: 'http.end', id: 0 })],
      [machineFrame, JSON.stringify({ type: 'http.end', id: 1.5 })],
      [machineFrame, JSON.stringify({ type: 'ws.close', channel: -1 })],
      [machineFrame, JSON.stringify({ type: 'ws.ack', channel: 1, bytes: 0 })],
      [serverFrame, JSON.stringify({ type: 'ws.ack', channel: 1, bytes: 1.5 })],
      [machineFrame, new Uint8Array([0, 0, 0])],
      [machineFrame, binary({ type: 'http.body', id: 1 }, new Uint8Array(), 1000)],
      [machineFrame, binary({ type: 'ping', nonce: 1 })],
      [machineFrame, binary({ type: 'http.body', id: 1, data: 'x' })],
      [machineFrame, binary({ type: 'http.body', id: 1 }, new Uint8Array(MAX_TUNNEL_FRAME_BYTES))],
      [machineFrame, JSON.stringify({ type: 'ws.data', channel: 1, data: 'x'.repeat(MAX_TUNNEL_FRAME_BYTES) })],
      [machineFrame, 42],
      [machineFrame, JSON.stringify({ type: 'auth.failed', id: 3, channel: 7 })],
      [machineFrame, JSON.stringify({ type: 'auth.failed' })],
      [machineFrame, JSON.stringify({ type: 'auth.failed', id: 3, key: 'k' })],
      [serverFrame, JSON.stringify({ type: 'auth.failed', id: 3 })],
      [machineFrame, JSON.stringify({ type: 'enroll.preview', id: 1, key: 'k' })],
      [machineFrame, JSON.stringify({ type: 'enroll.redeem', id: 0, key: 'k', email: 'e', name: 'Box' })],
      [
        machineFrame,
        JSON.stringify({ type: 'enroll.redeem', id: 1, key: 'k', email: 'e', name: 'Box', machineId: 'm-2' }),
      ],
      [machineFrame, JSON.stringify({ type: 'enroll.redeem', id: 1, key: 'k'.repeat(257), email: 'e', name: 'Box' })],
      [machineFrame, JSON.stringify({ type: 'enroll.redeem', id: 1, key: 'k', email: 'e'.repeat(321), name: 'Box' })],
      [machineFrame, JSON.stringify({ type: 'enroll.redeem', id: 1, key: 'k', email: 'e', name: '   ' })],
      [machineFrame, JSON.stringify({ type: 'enroll.redeem', id: 1, key: 'k', name: 'Box' })],
      [serverFrame, JSON.stringify({ type: 'enroll.redeem', id: 1, key: 'k', email: 'e', name: 'Box' })],
      [machineFrame, JSON.stringify({ type: 'unlink', id: 1 })],
      [machineFrame, JSON.stringify({ type: 'unlink', id: 1, accountId: '' })],
      [machineFrame, JSON.stringify({ type: 'unlink', id: 1, accountId: 'u1', machineId: 'm-2' })],
      [serverFrame, JSON.stringify({ type: 'unlink', id: 1, accountId: 'u1' })],
      [machineFrame, JSON.stringify({ type: 'unlinked', id: 1 })],
      [serverFrame, JSON.stringify({ type: 'unlinked', id: 1, removed: true })],
      [serverFrame, JSON.stringify({ type: 'unlink.failed', id: 1, code: 'invalid_key' })],
      [machineFrame, JSON.stringify({ type: 'enroll.failed', id: 1, code: 'invalid_key' })],
      [serverFrame, JSON.stringify({ type: 'enroll.failed', id: 1, code: 'expired' })],
    ]
    for (const [schema, input] of bad) expect(decodeFrame(schema, input)).toBeNull()
  })

  test('session.ended holds only a non-empty account id, and only the server sends it', () => {
    const frame = { type: 'session.ended', accountId: 'u1' } as const
    expect(decodeFrame(serverFrame, encodeFrame(frame))).toEqual(frame)
    for (const input of [
      { type: 'session.ended' },
      { type: 'session.ended', accountId: '' },
      { ...frame, sessionId: 's1' },
      { ...frame, email: 'ada@example.com' },
    ]) {
      expect(decodeFrame(serverFrame, JSON.stringify(input))).toBeNull()
    }
    expect(decodeFrame(machineFrame, JSON.stringify(frame))).toBeNull()
  })

  test('remote.off carries nothing else, and only the machine sends it', () => {
    const frame = { type: 'remote.off' } as const
    expect(decodeFrame(machineFrame, encodeFrame(frame))).toEqual(frame)
    expect(decodeFrame(machineFrame, JSON.stringify({ ...frame, reason: 'x' }))).toBeNull()
    expect(decodeFrame(serverFrame, JSON.stringify(frame))).toBeNull()
  })

  test('ws payloads count their UTF-8 length for strings and their byte length for binary', () => {
    for (const text of ['', 'abc', 'héllo', '€', '😀 ok', 'lone \ud800 surrogate']) {
      expect(wsPayloadBytes(text)).toBe(new TextEncoder().encode(text).byteLength)
    }
    expect(wsPayloadBytes(allBytes)).toBe(256)
  })
})

describe('hello helpers', () => {
  test('the signed message is the context, the version and the nonce, and changes with the nonce', () => {
    const text = new TextDecoder().decode(helloSignedMessage(nonce))
    expect(text).toBe(`orch-tunnel-hello\n${TUNNEL_PROTOCOL_VERSION}\n${nonce}`)
    expect(helloSignedMessage(publicKey)).not.toEqual(helloSignedMessage(nonce))
  })

  test('the machine id is the base64url SHA-256 of the raw key bytes', async () => {
    const raw = Uint8Array.from({ length: 32 }, (_, i) => i * 7)
    const key = Buffer.from(raw).toString('base64url')
    const expected = new Bun.CryptoHasher('sha256').update(raw).digest('base64url')
    expect(await machineIdFromPublicKey(key)).toBe(expected)
    expect(expected).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })
})

describe('parseServerUrl', () => {
  test('accepts wss for any host and ws only on loopback, keeping a base path', () => {
    expect(parseServerUrl('wss://relay.example.com')).toBe(`wss://relay.example.com${TUNNEL_PATH}`)
    expect(parseServerUrl('wss://relay.example.com:8443/base/')).toBe(`wss://relay.example.com:8443/base${TUNNEL_PATH}`)
    expect(parseServerUrl('ws://127.0.0.1:4600')).toBe(`ws://127.0.0.1:4600${TUNNEL_PATH}`)
    expect(parseServerUrl('ws://[::1]:4600')).toBe(`ws://[::1]:4600${TUNNEL_PATH}`)
    expect(parseServerUrl('ws://localhost:4600')).toBe(`ws://localhost:4600${TUNNEL_PATH}`)
    for (const value of [
      'ws://example.com',
      'ws://10.0.0.1',
      'ws://localhost.example.com',
      'ws://127.0.0.1.example.com',
      'http://127.0.0.1:4600',
      'https://relay.example.com',
      'relay.example.com',
      'wss://',
      'wss://user:pass@relay.example.com',
      'wss://relay.example.com/?a=1',
      'wss://relay.example.com/#x',
      '',
    ]) {
      expect(parseServerUrl(value)).toBeNull()
    }
  })

  test('sameServerUrl compares tunnel URLs and never matches an address that is not one', () => {
    expect(sameServerUrl(' wss://orch.example.com/ ', 'wss://orch.example.com')).toBe(true)
    expect(sameServerUrl('wss://orch.example.com', 'wss://other.example.com')).toBe(false)
    expect(sameServerUrl('ws://example.com', 'ws://example.com')).toBe(false)
  })
})
