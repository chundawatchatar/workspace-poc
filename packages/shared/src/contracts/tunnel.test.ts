import { describe, expect, test } from 'bun:test'
import {
  decodeFrame,
  encodeFrame,
  MAX_TUNNEL_FRAME_BYTES,
  machineFrame,
  serverFrame,
  type TunnelFrame,
  wsPayloadBytes,
} from './tunnel'

const proof = `${'A'.repeat(42)}w`
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
      { type: 'hello', version: 1, proof },
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
    ]
    const server: TunnelFrame[] = [
      { type: 'welcome', machineId: 'm-1' },
      { type: 'http.request', id: 3, method: 'GET', path: '/api/git/status?cwd=%2Ftmp', headers: [] },
      { type: 'http.request', id: 4, method: 'POST', path: '/api/fs/dirs', headers: [['x', 'y']], body: allBytes },
      { type: 'ws.open', channel: 1, path: '/ws/term/abc?cols=80', headers: [] },
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
      [serverFrame, JSON.stringify({ type: 'hello', version: 1, proof })],
      [machineFrame, JSON.stringify({ type: 'welcome', machineId: 'm' })],
      [machineFrame, JSON.stringify({ type: 'hello', version: 1, proof: 'short' })],
      [machineFrame, JSON.stringify({ type: 'hello', version: 1, proof: `${proof.slice(1)}+` })],
      [machineFrame, JSON.stringify({ type: 'hello', version: 1.5, proof })],
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
    ]
    for (const [schema, input] of bad) expect(decodeFrame(schema, input)).toBeNull()
  })

  test('ws payloads count their UTF-8 length for strings and their byte length for binary', () => {
    for (const text of ['', 'abc', 'héllo', '€', '😀 ok', 'lone \ud800 surrogate']) {
      expect(wsPayloadBytes(text)).toBe(new TextEncoder().encode(text).byteLength)
    }
    expect(wsPayloadBytes(allBytes)).toBe(256)
  })
})
