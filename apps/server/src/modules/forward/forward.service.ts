import { API_PREFIX, MAX_TUNNEL_FRAME_BYTES, type MachineFrame, type ServerFrame } from '@orch/shared'
import { frameBytes, relayedPath, relayedRequestHeaders } from '../../lib/relay'
import type { MachineConnection, MachineRegistry } from '../tunnel/tunnel.service'

// Framing of the response that the server redoes for the browser.
const DROPPED_RESPONSE_HEADERS = new Set(['content-length', 'transfer-encoding', 'connection'])

/** What the forwarder needs from the server. */
export interface HttpForwarderDeps {
  registry: MachineRegistry
  /** How long a machine has to send the head of its response. Defaults to 30 s. */
  requestTimeoutMs?: number
}

/** A request waiting for its response, or one whose body is still streaming. */
interface Pending {
  /** Settles the browser's `Response`. Only the first call counts. */
  resolve(response: Response): void
  timer: Timer | undefined
  /** Undefined until the head arrives, then the body's stream, or null when the status allows no body. */
  body: ReadableStreamDefaultController<Uint8Array> | null | undefined
  /** Detaches the browser abort listener. */
  detach(): void
}

/** The in-flight requests on one tunnel, by request id. It lives until the tunnel closes, so ids are never reused. */
interface ConnectionState {
  nextId: number
  pending: Map<number, Pending>
}

/**
 * The part of a request URL that goes to the machine: everything after
 * `/m/<machineId>`, query string included, exactly as the URL has it. Null
 * means the URL is not under a machine's `/api/`.
 */
export function forwardedPath(url: string): string | null {
  return relayedPath(url, API_PREFIX)
}

/**
 * Relays browser HTTP requests to machines over their tunnels and streams the
 * answers back. It routes on the frame envelope only (connection, request id,
 * sizes) and never looks at the method, path, headers, body or status.
 */
export class HttpForwarder {
  private readonly registry: MachineRegistry
  private readonly requestTimeoutMs: number
  private readonly connections = new Map<MachineConnection, ConnectionState>()
  // Tunnels that already closed. One may still sit in the registry until its close event arrives.
  private readonly closed = new WeakSet<MachineConnection>()

  constructor({ registry, requestTimeoutMs = 30_000 }: HttpForwarderDeps) {
    this.registry = registry
    this.requestTimeoutMs = requestTimeoutMs
  }

  /**
   * Sends `request` to the machine and resolves with its response once the head
   * arrives. Resolves with 502 when the machine is offline or its tunnel drops,
   * 504 when the head takes longer than `requestTimeoutMs`, and 413 when the
   * request does not fit in one tunnel frame.
   */
  async forward(machineId: string, request: Request): Promise<Response> {
    const path = forwardedPath(request.url)
    if (!path) return new Response('Not Found', { status: 404 })
    if (!this.live(machineId)) return offline()

    const body = request.body ? await readCapped(request.body, MAX_TUNNEL_FRAME_BYTES) : undefined
    if (body === null) return tooLarge()
    // Reading the body takes time, so look the tunnel up again.
    const conn = this.live(machineId)
    if (!conn) return offline()
    if (request.signal.aborted) return badGateway()

    const state = this.stateOf(conn)
    const id = state.nextId++
    const frame: ServerFrame = {
      type: 'http.request',
      id,
      method: request.method,
      path,
      headers: relayedRequestHeaders(request.headers),
      ...(body && body.byteLength > 0 ? { body } : {}),
    }
    if (frameBytes(frame) > MAX_TUNNEL_FRAME_BYTES) return tooLarge()

    return new Promise<Response>((resolve) => {
      let settled = false
      const onAbort = () => this.finish(conn, id, 'aborted')
      const entry: Pending = {
        resolve: (response) => {
          if (settled) return
          settled = true
          resolve(response)
        },
        timer: setTimeout(() => {
          this.finish(conn, id)
          entry.resolve(new Response('Gateway Timeout', { status: 504 }))
        }, this.requestTimeoutMs),
        body: undefined,
        detach: () => request.signal.removeEventListener('abort', onAbort),
      }
      state.pending.set(id, entry)
      request.signal.addEventListener('abort', onAbort, { once: true })
      conn.send(frame)
    })
  }

  /** Takes an `http.response`, `http.body` or `http.end` from `conn`. Frames for unknown or finished ids are ignored. */
  handleFrame(conn: MachineConnection, frame: MachineFrame): void {
    if (frame.type !== 'http.response' && frame.type !== 'http.body' && frame.type !== 'http.end') return
    const entry = this.connections.get(conn)?.pending.get(frame.id)
    if (!entry) return

    if (frame.type === 'http.response') {
      if (entry.body !== undefined) return
      clearTimeout(entry.timer)
      const response = buildResponse(frame.status, frame.headers, () => this.finish(conn, frame.id))
      if (!response) {
        this.finish(conn, frame.id)
        entry.resolve(badGateway())
        return
      }
      entry.body = response.controller
      entry.resolve(response.response)
    } else if (frame.type === 'http.body') {
      // The payload is a view into the socket message, so copy it before it is queued.
      entry.body?.enqueue(frame.data.slice())
    } else if (entry.body === undefined) {
      // The machine gave up before sending a head.
      this.finish(conn, frame.id)
      entry.resolve(badGateway())
    } else {
      this.finish(conn, frame.id, frame.error === undefined ? 'end' : 'failed')
    }
  }

  /** Fails every request still waiting on `conn`: 502 before the head, a body error after it. */
  connectionClosed(conn: MachineConnection): void {
    this.closed.add(conn)
    const state = this.connections.get(conn)
    if (!state) return
    for (const id of [...state.pending.keys()]) this.finish(conn, id, 'failed')
    this.connections.delete(conn)
  }

  /** The number of requests in flight, across every tunnel. */
  get size(): number {
    let size = 0
    for (const state of this.connections.values()) size += state.pending.size
    return size
  }

  private live(machineId: string): MachineConnection | undefined {
    const conn = this.registry.get(machineId)
    return conn && !this.closed.has(conn) ? conn : undefined
  }

  private stateOf(conn: MachineConnection): ConnectionState {
    let state = this.connections.get(conn)
    if (!state) {
      state = { nextId: 1, pending: new Map() }
      this.connections.set(conn, state)
    }
    return state
  }

  /**
   * Forgets a request. With `end` its body closes normally; with `failed` or
   * `aborted` a waiting request gets 502 and a streaming body errors.
   */
  private finish(conn: MachineConnection, id: number, how?: 'end' | 'failed' | 'aborted'): void {
    const state = this.connections.get(conn)
    const entry = state?.pending.get(id)
    if (!state || !entry) return
    state.pending.delete(id)
    clearTimeout(entry.timer)
    entry.detach()
    if (!how) return
    if (entry.body === undefined) {
      entry.resolve(badGateway())
      return
    }
    // The stream may already be closed or cancelled by the browser, which makes these throw.
    try {
      if (how === 'end') entry.body?.close()
      else entry.body?.error(new Error('the machine response did not complete'))
    } catch {}
  }
}

function offline(): Response {
  return new Response('Machine offline', { status: 502 })
}

function badGateway(): Response {
  return new Response('Bad Gateway', { status: 502 })
}

function tooLarge(): Response {
  return new Response('Request body too large', { status: 413 })
}

/** Reads a body into one buffer. Null means it is larger than `cap`, and reading stops there. */
async function readCapped(stream: ReadableStream<Uint8Array>, cap: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > cap) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/**
 * Builds the browser's response from a head. Statuses that cannot carry a body
 * get none, and their later body frames are dropped. Null means the head cannot
 * be expressed as a `Response` (a 1xx status or an invalid header).
 */
function buildResponse(
  status: number,
  pairs: [string, string][],
  onCancel: () => void,
): { response: Response; controller: ReadableStreamDefaultController<Uint8Array> | null } | null {
  try {
    const headers = new Headers()
    for (const [name, value] of pairs) {
      if (!DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) headers.append(name, value)
    }
    if (status === 204 || status === 205 || status === 304) {
      return { response: new Response(null, { status, headers }), controller: null }
    }
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    const stream = new ReadableStream<Uint8Array>({
      start: (c) => {
        controller = c
      },
      cancel: onCancel,
    })
    const response = new Response(stream, { status, headers })
    return controller ? { response, controller } : null
  } catch {
    return null
  }
}
