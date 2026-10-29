import { encodeFrame, type ServerFrame } from '@orch/shared'

// Transport framing that does not survive the hop through the tunnel. Dropping
// these is part of re-framing a request, not reading it: HTTP bodies are sent in
// one frame on the way in, and a socket's handshake is the server's own.
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'host',
])
// The handshake headers of the browser's socket, which ends at the server.
// `sec-websocket-protocol` is kept: the server negotiates no subprotocol, so it
// is the machine's to read.
const SOCKET_HANDSHAKE_HEADERS = new Set(['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions'])
// The browser's cookies for the server's origin, which hold the account
// session. Machines share that origin under `/m/<id>`, so a machine never sees
// them. This is a filter on header names: cookie values are never read.
const ACCOUNT_COOKIE_HEADERS = new Set(['cookie'])

const encoder = new TextEncoder()

/**
 * The part of a request URL that goes to the machine: everything after
 * `/m/<machineId>`, query string included, exactly as the URL has it. Null
 * means the URL is not under the machine's `prefix` (`/api` or `/ws`).
 */
export function relayedPath(url: string, prefix: string): string | null {
  const pathStart = url.indexOf('/', url.indexOf('//') + 2)
  if (pathStart < 0) return null
  const raw = url.slice(pathStart).split('#')[0] ?? ''
  const match = /^\/m\/[^/?]+(\/.*)$/.exec(raw)
  const path = match?.[1]
  return path?.startsWith(`${prefix}/`) ? path : null
}

/** The headers of an HTTP request that go to the machine, in order. */
export function relayedRequestHeaders(headers: Headers): [string, string][] {
  return [...headers].filter(([name]) => !isDroppedRequestHeader(name))
}

/** The headers of a socket's upgrade request that go to the machine, in order. */
export function relayedSocketHeaders(headers: Headers): [string, string][] {
  return [...headers].filter(
    ([name]) => !isDroppedRequestHeader(name) && !SOCKET_HANDSHAKE_HEADERS.has(name.toLowerCase()),
  )
}

/** The size of a frame once encoded for the tunnel. */
export function frameBytes(frame: ServerFrame): number {
  const encoded = encodeFrame(frame)
  return typeof encoded === 'string' ? encoder.encode(encoded).byteLength : encoded.byteLength
}

/** True for a request header that never reaches the machine: hop-by-hop framing, or the account cookies. */
function isDroppedRequestHeader(name: string): boolean {
  const lower = name.toLowerCase()
  return HOP_BY_HOP_HEADERS.has(lower) || lower.startsWith('proxy-') || ACCOUNT_COOKIE_HEADERS.has(lower)
}
