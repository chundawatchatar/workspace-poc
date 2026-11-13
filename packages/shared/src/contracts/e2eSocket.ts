import { z } from 'zod'
import { WS_PREFIX } from './contract'
import { E2eError } from './e2e'
import { checked, parseJson, tagged } from './e2eHttp'
import { socketAuthMessage } from './remote'
import { MAX_TUNNEL_FRAME_BYTES } from './tunnel'

// The records of a WebSocket sealed end to end (REM-2), shared by the browser
// and the host. The browser opens a socket on the server's sealed socket route
// and sends one envelope (`e2eHttp.ts`) as its first message: the session id, a
// channel number and the open record sealed on that channel. The server relays
// it unread as `ws.sealed`. After that, every `ws.data` payload either way is
// one text or binary message record sealed on the same channel, in order. Every
// record starts with a byte that tags its kind, inside the seal; the tags are
// apart from the HTTP ones, so no record is read as another. Web-standard APIs only.

/**
 * What a sealed socket opens with: the socket path, the auth message that used
 * to be its first message, and with `account: true` the relay ticket that used
 * to go in a subprotocol.
 */
export const e2eSocketOpen = z.strictObject({
  /** A host socket path under `/ws/`, with its query string. */
  path: z.string().startsWith(`${WS_PREFIX}/`),
  auth: socketAuthMessage,
  ticket: z.string().min(1).max(4096).optional(),
})
export type E2eSocketOpen = z.infer<typeof e2eSocketOpen>

/** One socket message: a string is a text message and bytes a binary one. */
export type E2eSocketMessage = string | Uint8Array

/** The tag byte of each record kind. The HTTP records take 1 to 4. */
const KIND = { open: 16, text: 17, binary: 18 } as const

/**
 * The largest message, in bytes (UTF-8 for text), that a sealed socket
 * carries: its sealed record still fits in one `ws.data` frame.
 */
export const MAX_E2E_SOCKET_MESSAGE_BYTES = MAX_TUNNEL_FRAME_BYTES - 1024

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

/** The plaintext of an open record: its tag, then the open record as JSON. */
export function encodeSocketOpenRecord(open: E2eSocketOpen): Uint8Array<ArrayBuffer> {
  return tagged(KIND.open, encoder.encode(JSON.stringify(checked(e2eSocketOpen, open))))
}

/** Reads an opened open record. Throws `E2eError` for another kind or a record that fails its schema. */
export function decodeSocketOpenRecord(plaintext: Uint8Array): E2eSocketOpen {
  if (plaintext[0] !== KIND.open) throw new E2eError('bad message')
  return parseJson(e2eSocketOpen, plaintext.subarray(1))
}

/** The plaintext of a message record. Throws `E2eError` for one over `MAX_E2E_SOCKET_MESSAGE_BYTES`. */
export function encodeSocketMessageRecord(message: E2eSocketMessage): Uint8Array<ArrayBuffer> {
  const record = typeof message === 'string' ? tagged(KIND.text, encoder.encode(message)) : tagged(KIND.binary, message)
  if (record.byteLength - 1 > MAX_E2E_SOCKET_MESSAGE_BYTES) throw new E2eError('bad message')
  return record
}

/**
 * Reads an opened message record: a string for a text message, bytes for a
 * binary one. Throws `E2eError` for another kind or text that isn't UTF-8.
 */
export function decodeSocketMessageRecord(plaintext: Uint8Array): E2eSocketMessage {
  const body = plaintext.subarray(1)
  if (plaintext[0] === KIND.binary) return body
  if (plaintext[0] !== KIND.text) throw new E2eError('bad message')
  try {
    return decoder.decode(body)
  } catch {
    throw new E2eError('bad message')
  }
}
