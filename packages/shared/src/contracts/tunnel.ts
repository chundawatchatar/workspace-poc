import { z } from 'zod'
import { API_PREFIX, WS_PREFIX } from './contract'

// The wire format between a machine and the cloud server (`apps/server`). Each
// machine keeps one outbound WSS connection to the server, which relays browser
// HTTP requests and WebSockets over it as these frames. This file runs in the
// host, the server and the browser, so it uses only web-standard APIs.

export const TUNNEL_PROTOCOL_VERSION = 1

/** The server path machines open their tunnel socket on. Its messages are tunnel frames, not JSON client messages. */
export const TUNNEL_PATH = '/tunnel'

/** The largest encoded frame, in bytes, that `decodeFrame` accepts. A request body must fit in one frame. */
export const MAX_TUNNEL_FRAME_BYTES = 1024 * 1024

/**
 * The most unacknowledged `ws.data` payload bytes a sender may have on one
 * channel. A sender may start a message while it is under the window, so one
 * large message cannot deadlock a channel. The receiver acks with `ws.ack` once
 * it has delivered the bytes.
 */
export const WS_CHANNEL_WINDOW_BYTES = 256 * 1024

/** Close code for a `hello` with another protocol version. The machine should not retry until it is updated. */
export const CLOSE_UNSUPPORTED_VERSION = 4000
/** Close code for a tunnel that a newer connection from the same machine took over. */
export const CLOSE_REPLACED = 4001
/** Close code for a machine that sent nothing for the server's heartbeat timeout. */
export const CLOSE_HEARTBEAT_TIMEOUT = 4002

const id = z.number().int().positive()
const bytes = z.instanceof(Uint8Array)
/** Header `[name, value]` pairs in order, so repeated headers survive. */
const headers = z.array(z.tuple([z.string(), z.string()]))

/** Opens the tunnel. `proof` is the machine secret (32 bytes, base64url), which the server hashes into the machine id. */
export const helloFrame = z.object({
  type: z.literal('hello'),
  version: z.number().int().positive(),
  proof: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
})

/** The server's answer to `hello`, telling the machine its id. */
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
  path: z.string().startsWith(`${WS_PREFIX}/`),
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

/** Gives back `bytes` of window on `channel`: the receiver has delivered that many `ws.data` payload bytes. */
export const wsAckFrame = z.object({ type: z.literal('ws.ack'), channel: id, bytes: z.number().int().positive() })

export const pingFrame = z.object({ type: z.literal('ping'), nonce: z.number().int() })

/** Answers a `ping`, echoing its `nonce`. */
export const pongFrame = z.object({ type: z.literal('pong'), nonce: z.number().int() })

/** Frames the machine sends to the server. */
export const machineFrame = z.discriminatedUnion('type', [
  helloFrame,
  httpResponseFrame,
  httpBodyFrame,
  httpEndFrame,
  wsDataFrame,
  wsCloseFrame,
  wsAckFrame,
  pingFrame,
  pongFrame,
])

/** Frames the server sends to the machine. */
export const serverFrame = z.discriminatedUnion('type', [
  welcomeFrame,
  httpRequestFrame,
  wsOpenFrame,
  wsDataFrame,
  wsCloseFrame,
  wsAckFrame,
  pingFrame,
  pongFrame,
])

export type MachineFrame = z.infer<typeof machineFrame>
export type ServerFrame = z.infer<typeof serverFrame>
export type TunnelFrame = MachineFrame | ServerFrame

/** The field that holds the raw bytes, for each frame type that can carry them. */
const byteField: Partial<Record<TunnelFrame['type'], string>> = {
  'http.request': 'body',
  'http.body': 'data',
  'ws.data': 'data',
}

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

/**
 * The bytes a `ws.data` payload counts for in a channel's window: the UTF-8
 * length of a string, the byte length of binary data. Strings are measured
 * without encoding them.
 */
export function wsPayloadBytes(data: string | Uint8Array): number {
  if (typeof data !== 'string') return data.byteLength
  let bytes = 0
  for (let i = 0; i < data.length; i++) {
    const unit = data.charCodeAt(i)
    if (unit < 0x80) bytes += 1
    else if (unit < 0x800) bytes += 2
    else if (unit >= 0xd800 && unit < 0xdc00 && (data.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 4
      i++
    } else {
      // Other units, lone surrogates included (they encode as U+FFFD), take 3 bytes.
      bytes += 3
    }
  }
  return bytes
}

/**
 * Encodes a frame for the tunnel socket. A frame without bytes becomes a JSON
 * text message. A frame carrying a `Uint8Array` becomes a binary message:
 * a big-endian u32 header length, the JSON header without the byte field,
 * then the raw bytes.
 */
export function encodeFrame(frame: TunnelFrame): string | Uint8Array<ArrayBuffer> {
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
