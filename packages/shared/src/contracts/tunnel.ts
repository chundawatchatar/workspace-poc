import { z } from 'zod'
import { API_PREFIX } from './contract'

// The wire format between a machine and the cloud relay. Each machine keeps one
// outbound WSS connection to the relay, which carries browser HTTP requests and
// WebSockets over it as these frames. This file runs in the host, the relay and
// the browser, so it uses only web-standard APIs.

export const TUNNEL_PROTOCOL_VERSION = 1

/** The largest encoded frame, in bytes, that `decodeFrame` accepts. A request body must fit in one frame. */
export const MAX_TUNNEL_FRAME_BYTES = 1024 * 1024

const id = z.number().int().positive()
const bytes = z.instanceof(Uint8Array)
/** Header `[name, value]` pairs in order, so repeated headers survive. */
const headers = z.array(z.tuple([z.string(), z.string()]))

/** Opens the tunnel. `proof` is the machine secret (32 bytes, base64url), which the relay hashes into the machine id. */
export const helloFrame = z.object({
  type: z.literal('hello'),
  version: z.number().int().positive(),
  proof: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
})

/** The relay's answer to `hello`, telling the machine its id. */
export const welcomeFrame = z.object({ type: z.literal('welcome'), machineId: z.string().min(1) })

/** A browser HTTP request. `path` starts with `/api/` and may carry a query string. */
export const httpRequestFrame = z.object({
  type: z.literal('http.request'),
  id,
  method: z.string().min(1),
  path: z.string().startsWith(`${API_PREFIX}/`),
  headers,
  body: bytes.optional(),
})

/** The head of the response to the request with the same `id`. */
export const httpResponseFrame = z.object({
  type: z.literal('http.response'),
  id,
  status: z.number().int().min(100).max(599),
  headers,
})

/** One chunk of a response body. */
export const httpBodyFrame = z.object({ type: z.literal('http.body'), id, data: bytes })

/** Ends a response. `error` is set when it failed mid-stream. */
export const httpEndFrame = z.object({ type: z.literal('http.end'), id, error: z.string().optional() })

/** A browser WebSocket opening on `channel`. `path` starts with `/ws/` and may carry a query string. */
export const wsOpenFrame = z.object({
  type: z.literal('ws.open'),
  channel: id,
  path: z.string().startsWith('/ws/'),
  headers,
})

/** One WebSocket message: a string is a text message and a `Uint8Array` a binary one. */
export const wsDataFrame = z.object({ type: z.literal('ws.data'), channel: id, data: z.union([z.string(), bytes]) })

/** Closes a channel, from either side. */
export const wsCloseFrame = z.object({
  type: z.literal('ws.close'),
  channel: id,
  code: z.number().int().min(1000).max(4999).optional(),
  reason: z.string().optional(),
})

export const pingFrame = z.object({ type: z.literal('ping'), nonce: z.number().int() })

/** Answers a `ping`, echoing its `nonce`. */
export const pongFrame = z.object({ type: z.literal('pong'), nonce: z.number().int() })

/** Frames the machine sends to the relay. */
export const machineFrame = z.discriminatedUnion('type', [
  helloFrame,
  httpResponseFrame,
  httpBodyFrame,
  httpEndFrame,
  wsDataFrame,
  wsCloseFrame,
  pingFrame,
  pongFrame,
])

/** Frames the relay sends to the machine. */
export const relayFrame = z.discriminatedUnion('type', [
  welcomeFrame,
  httpRequestFrame,
  wsOpenFrame,
  wsDataFrame,
  wsCloseFrame,
  pingFrame,
  pongFrame,
])

export type MachineFrame = z.infer<typeof machineFrame>
export type RelayFrame = z.infer<typeof relayFrame>
export type TunnelFrame = MachineFrame | RelayFrame

/** The field that holds the raw bytes, for each frame type that can carry them. */
const byteField: Partial<Record<TunnelFrame['type'], string>> = {
  'http.request': 'body',
  'http.body': 'data',
  'ws.data': 'data',
}

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

/**
 * Encodes a frame for the tunnel socket. A frame without bytes becomes a JSON
 * text message. A frame carrying a `Uint8Array` becomes a binary message:
 * a big-endian u32 header length, the JSON header without the byte field,
 * then the raw bytes.
 */
export function encodeFrame(frame: TunnelFrame): string | Uint8Array {
  const field = byteField[frame.type]
  const payload = field ? (frame as Record<string, unknown>)[field] : undefined
  if (!field || !(payload instanceof Uint8Array)) return JSON.stringify(frame)
  const { [field]: _, ...rest } = frame as Record<string, unknown>
  const header = encoder.encode(JSON.stringify(rest))
  const out = new Uint8Array(4 + header.byteLength + payload.byteLength)
  new DataView(out.buffer).setUint32(0, header.byteLength)
  out.set(header, 4)
  out.set(payload, 4 + header.byteLength)
  return out
}

/**
 * Decodes a tunnel message (a string, an `ArrayBuffer` or a `Uint8Array`) and
 * checks it against `schema`. Returns null for anything malformed, larger than
 * `MAX_TUNNEL_FRAME_BYTES` or not in `schema`. Byte fields come back as views
 * into `data`, not copies.
 */
export function decodeFrame<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> | null {
  let value: unknown
  try {
    if (typeof data === 'string') {
      // UTF-8 takes at most 3 bytes per UTF-16 unit, so only long strings need measuring.
      if (data.length > MAX_TUNNEL_FRAME_BYTES) return null
      if (data.length * 3 > MAX_TUNNEL_FRAME_BYTES && encoder.encode(data).byteLength > MAX_TUNNEL_FRAME_BYTES) {
        return null
      }
      value = JSON.parse(data)
    } else if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
      // A plain view, so a Bun `Buffer` input still yields `Uint8Array` payloads.
      const view =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      value = decodeBinary(view)
    } else {
      return null
    }
  } catch {
    return null
  }
  if (value === null) return null
  const result = schema.safeParse(value)
  return result.success ? result.data : null
}

/** Splits a binary message into its header and payload. Throws or returns null when malformed. */
function decodeBinary(view: Uint8Array): unknown {
  if (view.byteLength > MAX_TUNNEL_FRAME_BYTES || view.byteLength < 4) return null
  const headerLength = new DataView(view.buffer, view.byteOffset, view.byteLength).getUint32(0)
  if (headerLength > view.byteLength - 4) return null
  const header: unknown = JSON.parse(decoder.decode(view.subarray(4, 4 + headerLength)))
  if (typeof header !== 'object' || header === null || Array.isArray(header)) return null
  const type = (header as { type?: unknown }).type
  const field = typeof type === 'string' ? byteField[type as TunnelFrame['type']] : undefined
  if (!field || Object.hasOwn(header, field)) return null
  return { ...header, [field]: view.subarray(4 + headerLength) }
}
