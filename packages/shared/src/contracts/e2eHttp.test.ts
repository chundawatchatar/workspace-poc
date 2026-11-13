import { describe, expect, test } from 'bun:test'
import { E2eError } from './e2e'
import {
  decodeEnvelope,
  decodeRequestRecord,
  decodeResponseRecord,
  type E2eHttpResponseRecord,
  encodeEnvelope,
  encodeRequestRecord,
  encodeResponseRecord,
  frameRecord,
  MAX_E2E_ENVELOPE_BYTES,
  RecordFramer,
} from './e2eHttp'

const sessionId = 'AAECAwQFBgcICQoLDA0ODw'
const sealed = Uint8Array.from({ length: 40 }, (_, i) => i)

function fails(run: () => unknown) {
  expect(run).toThrow(E2eError)
}

describe('sealed HTTP wire format', () => {
  test('the envelope round-trips as the raw session id, a big-endian channel and the sealed record', () => {
    const bytes = encodeEnvelope({ sessionId, channel: 258, sealed })
    expect([...bytes.subarray(0, 20)]).toEqual([...Array.from({ length: 16 }, (_, i) => i), 0, 0, 1, 2])
    expect(decodeEnvelope(bytes)).toEqual({ sessionId, channel: 258, sealed })
    expect(decodeEnvelope(encodeEnvelope({ sessionId, channel: 2 ** 32 - 1, sealed })).channel).toBe(2 ** 32 - 1)
  })

  test('a truncated, oversized or channel 0 envelope is refused, and so is a bad id or channel to encode', () => {
    const bytes = encodeEnvelope({ sessionId, channel: 1, sealed })
    fails(() => decodeEnvelope(bytes.subarray(0, 16 + 4 + 23)))
    fails(() => decodeEnvelope(new Uint8Array(MAX_E2E_ENVELOPE_BYTES + 1)))
    fails(() => decodeEnvelope(new Uint8Array(64)))
    fails(() => encodeEnvelope({ sessionId: 'short', channel: 1, sealed }))
    fails(() => encodeEnvelope({ sessionId, channel: 0, sealed }))
    fails(() => encodeEnvelope({ sessionId, channel: 1, sealed: new Uint8Array(MAX_E2E_ENVELOPE_BYTES) }))
  })

  test('request and response records round-trip, and a record of the wrong kind or shape is refused', () => {
    const request = {
      method: 'POST',
      path: '/api/fs/dirs?x=1',
      headers: [['a', 'b']] as [string, string][],
      body: '{}',
    }
    expect(decodeRequestRecord(encodeRequestRecord(request))).toEqual(request)
    const head: E2eHttpResponseRecord = { kind: 'head', head: { status: 201, headers: [['x-n', '1']] } }
    const records: E2eHttpResponseRecord[] = [
      head,
      { kind: 'body', data: Uint8Array.of(0, 255) },
      { kind: 'end' },
      { kind: 'end', error: 'x' },
    ]
    for (const record of records) expect(decodeResponseRecord(encodeResponseRecord(record))).toEqual(record)

    fails(() => decodeRequestRecord(encodeResponseRecord(head)))
    fails(() => decodeResponseRecord(encodeRequestRecord(request)))
    fails(() => decodeResponseRecord(Uint8Array.of(9)))
    fails(() => decodeResponseRecord(new Uint8Array()))
    fails(() => decodeRequestRecord(encodeRequestRecord(request).subarray(0, 10)))
    fails(() => encodeRequestRecord({ ...request, path: '/ws/events' }))
    fails(() => decodeResponseRecord(Uint8Array.of(2, ...new TextEncoder().encode('{"status":101,"headers":[]}'))))
  })

  test('framed records come back whole whatever chunks the body arrives in, and a part record stays pending', () => {
    const framed = [frameRecord(Uint8Array.of(1, 2, 3)), frameRecord(new Uint8Array()), frameRecord(Uint8Array.of(4))]
    const joined = Uint8Array.from(framed.flatMap((record) => [...record]))
    const framer = new RecordFramer()
    const out = [...joined].flatMap((byte) => framer.push(Uint8Array.of(byte)))
    expect(out).toEqual([Uint8Array.of(1, 2, 3), new Uint8Array(), Uint8Array.of(4)])
    expect(framer.pending).toBe(0)
    expect(framer.push(joined.subarray(0, 5))).toEqual([])
    expect(framer.pending).toBe(5)
    fails(() => new RecordFramer().push(Uint8Array.of(0xff, 0xff, 0xff, 0xff)))
  })
})
