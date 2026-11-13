import { z } from 'zod'
import { API_PREFIX } from './contract'
import { E2eError, MAX_E2E_CHANNEL } from './e2e'
import { fromBase64url, MAX_TUNNEL_FRAME_BYTES } from './tunnel'

// The wire format of HTTP sealed end to end (REM-2), shared by the browser and
// the host. The browser posts an envelope to the server's sealed route: the
// session id, a channel number and the request record sealed on that channel
// of the session. The server relays it as `http.sealed` by its envelope only.
// The host answers on the same channel with sealed response records (a head,
// body chunks, an end), each length-prefixed in the outer response body, so a
// streamed response still streams. Every record starts with a byte that tags
// its kind, inside the seal. Web-standard APIs only.

/** The code of the unsealed 409 a host answers for a session it doesn't have (unknown, expired or closed). */
export const E2E_SESSION_UNKNOWN_CODE = 'e2e_session_unknown'

/**
 * The code of the 403 a host answers through the tunnel for a plain request
 * other than the handshake and the key bootstrap, which must come sealed.
 */
export const E2E_REQUIRED_CODE = 'e2e_required'

/** Header `[name, value]` pairs in order, so repeated headers survive. */
const headers = z.array(z.tuple([z.string(), z.string()]))

/** A sealed request: what the page asked for, with its credentials and device proof in `headers`. */
export const e2eHttpRequest = z.strictObject({
  method: z.string().min(1),
  /** A host path under `/api/`, with its query string. */
  path: z.string().startsWith(`${API_PREFIX}/`),
  headers,
  /** The body, as the transport accepts only string bodies. */
  body: z.string().optional(),
})
export type E2eHttpRequest = z.infer<typeof e2eHttpRequest>

/** The head of a sealed response. */
export const e2eHttpHead = z.strictObject({ status: z.number().int().min(200).max(599), headers })
export type E2eHttpHead = z.infer<typeof e2eHttpHead>

/** One response record, in the order they are sealed: one head, any number of body chunks, then one end. */
export type E2eHttpResponseRecord =
  | { kind: 'head'; head: E2eHttpHead }
  | { kind: 'body'; data: Uint8Array }
  /** `error` is set when the response failed mid-stream. */
  | { kind: 'end'; error?: string }

const e2eHttpEnd = z.strictObject({ error: z.string().max(200).optional() })

/** The tag byte of each record kind. */
const KIND = { request: 1, head: 2, body: 3, end: 4 } as const

const SESSION_ID_BYTES = 16
const CHANNEL_BYTES = 4
/** A sealed record's 8-byte counter and 16-byte tag. */
const SEAL_OVERHEAD = 24
const LENGTH_BYTES = 4

/** The largest envelope a host opens, and so the largest the browser sends. */
export const MAX_E2E_ENVELOPE_BYTES = MAX_TUNNEL_FRAME_BYTES - 1024

/** The largest sealed response record a browser reads. */
export const MAX_E2E_RECORD_BYTES = MAX_TUNNEL_FRAME_BYTES

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

/** What an envelope carries: the session it names, the channel and the sealed request record. */
export interface E2eEnvelope {
  /** The session id, as `routes.e2e.open` answered it (22 base64url characters). */
  sessionId: string
  channel: number
  sealed: Uint8Array
}

/** The envelope's bytes: the raw 16-byte session id, the channel as a big-endian u32, then the sealed record. */
export function encodeEnvelope({ sessionId, channel, sealed }: E2eEnvelope): Uint8Array<ArrayBuffer> {
  const id = /^[A-Za-z0-9_-]{22}$/.test(sessionId) ? fromBase64url(sessionId) : null
  if (id?.length !== SESSION_ID_BYTES) throw new E2eError('bad message')
  if (!Number.isInteger(channel) || channel < 1 || channel > MAX_E2E_CHANNEL) throw new E2eError('bad message')
  const out = new Uint8Array(SESSION_ID_BYTES + CHANNEL_BYTES + sealed.byteLength)
  if (out.byteLength > MAX_E2E_ENVELOPE_BYTES) throw new E2eError('bad message')
  out.set(id, 0)
  new DataView(out.buffer).setUint32(SESSION_ID_BYTES, channel)
  out.set(sealed, SESSION_ID_BYTES + CHANNEL_BYTES)
  return out
}

/** Reads an envelope. Throws `E2eError` for one too short to hold a sealed record, too large, or on channel 0. */
export function decodeEnvelope(data: Uint8Array): E2eEnvelope {
  if (data.byteLength < SESSION_ID_BYTES + CHANNEL_BYTES + SEAL_OVERHEAD) throw new E2eError('bad message')
  if (data.byteLength > MAX_E2E_ENVELOPE_BYTES) throw new E2eError('bad message')
  const channel = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(SESSION_ID_BYTES)
  if (channel < 1) throw new E2eError('bad message')
  return {
    sessionId: toBase64url(data.subarray(0, SESSION_ID_BYTES)),
    channel,
    sealed: data.subarray(SESSION_ID_BYTES + CHANNEL_BYTES),
  }
}

/** The plaintext of a request record: its tag, then the request as JSON. */
export function encodeRequestRecord(request: E2eHttpRequest): Uint8Array<ArrayBuffer> {
  return tagged(KIND.request, encoder.encode(JSON.stringify(checked(e2eHttpRequest, request))))
}

/** Reads an opened request record. Throws `E2eError` for another kind or a request that fails its schema. */
export function decodeRequestRecord(plaintext: Uint8Array): E2eHttpRequest {
  if (plaintext[0] !== KIND.request) throw new E2eError('bad message')
  return parseJson(e2eHttpRequest, plaintext.subarray(1))
}

/** The plaintext of a response record: its tag, then the head or end as JSON, or the raw body bytes. */
export function encodeResponseRecord(record: E2eHttpResponseRecord): Uint8Array<ArrayBuffer> {
  if (record.kind === 'body') return tagged(KIND.body, record.data)
  if (record.kind === 'head')
    return tagged(KIND.head, encoder.encode(JSON.stringify(checked(e2eHttpHead, record.head))))
  const end = record.error === undefined ? {} : { error: record.error }
  return tagged(KIND.end, encoder.encode(JSON.stringify(checked(e2eHttpEnd, end))))
}

/** Reads an opened response record. Throws `E2eError` for a request record, an unknown tag or a malformed one. */
export function decodeResponseRecord(plaintext: Uint8Array): E2eHttpResponseRecord {
  const body = plaintext.subarray(1)
  switch (plaintext[0]) {
    case KIND.head:
      return { kind: 'head', head: parseJson(e2eHttpHead, body) }
    case KIND.body:
      return { kind: 'body', data: body }
    case KIND.end: {
      const { error } = parseJson(e2eHttpEnd, body)
      return error === undefined ? { kind: 'end' } : { kind: 'end', error }
    }
    default:
      throw new E2eError('bad message')
  }
}

/** A sealed record as it goes in the outer response body: its length as a big-endian u32, then its bytes. */
export function frameRecord(sealed: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(LENGTH_BYTES + sealed.byteLength)
  new DataView(out.buffer).setUint32(0, sealed.byteLength)
  out.set(sealed, LENGTH_BYTES)
  return out
}

/**
 * Splits the outer response body back into sealed records, whatever chunks it
 * arrives in. `push` returns the records a chunk completes; `pending` counts
 * the bytes of a record not yet complete, so a stream that ends with some is
 * truncated. A record larger than `MAX_E2E_RECORD_BYTES` throws `E2eError`.
 */
export class RecordFramer {
  private buffer: Uint8Array = new Uint8Array()

  push(chunk: Uint8Array): Uint8Array[] {
    const joined = new Uint8Array(this.buffer.byteLength + chunk.byteLength)
    joined.set(this.buffer, 0)
    joined.set(chunk, this.buffer.byteLength)
    const records: Uint8Array[] = []
    let offset = 0
    while (joined.byteLength - offset >= LENGTH_BYTES) {
      const length = new DataView(joined.buffer, offset, LENGTH_BYTES).getUint32(0)
      if (length > MAX_E2E_RECORD_BYTES) throw new E2eError('bad message')
      if (joined.byteLength - offset - LENGTH_BYTES < length) break
      records.push(joined.slice(offset + LENGTH_BYTES, offset + LENGTH_BYTES + length))
      offset += LENGTH_BYTES + length
    }
    this.buffer = joined.slice(offset)
    return records
  }

  get pending(): number {
    return this.buffer.byteLength
  }
}

/** `payload` behind the tag byte `kind`. Not re-exported from the index. */
export function tagged(kind: number, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(1 + payload.byteLength)
  out[0] = kind
  out.set(payload, 1)
  return out
}

/**
 * `value` checked against `schema`, throwing `E2eError` rather than an error that could quote it. Not re-exported
 * from the index.
 */
export function checked<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new E2eError('bad message')
  return parsed.data
}

/** `bytes` read as UTF-8 JSON and checked against `schema`, throwing `E2eError`. Not re-exported from the index. */
export function parseJson<T>(schema: z.ZodType<T>, bytes: Uint8Array): T {
  let value: unknown
  try {
    value = JSON.parse(decoder.decode(bytes))
  } catch {
    throw new E2eError('bad message')
  }
  return checked(schema, value)
}

function toBase64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
