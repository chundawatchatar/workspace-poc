import { ACCESS_KEY_HEADER, API_PREFIX, type httpRequestFrame, type MachineFrame } from '@orch/shared'
import type { z } from 'zod'
import { HOST_ORIGIN } from '../../lib/localOrigin'
import type { Principal } from '../../lib/principal'

type HttpRequestFrame = z.infer<typeof httpRequestFrame>

/**
 * Answers one tunneled request, as the key that authorized it. The principal
 * is null only for a CORS preflight, which carries no key. In the host this is
 * `app.fetch`.
 */
export type TunnelHandler = (request: Request, principal: Principal | null) => Promise<Response>

/** Decides whether an access key may in. In the host this is `AccessKeys.authorize`. */
export type Authorize = (key: string | null) => Principal | null

/**
 * The access key of a request: the value of its one `ACCESS_KEY_HEADER`, or
 * null when there is none or more than one. Never read from the query string.
 */
export function accessKeyOf(headers: [string, string][]): string | null {
  const values = headers.filter(([name]) => name.toLowerCase() === ACCESS_KEY_HEADER)
  return values.length === 1 ? (values[0]?.[1] ?? null) : null
}

/**
 * True for a CORS preflight. Browsers send it without custom headers, so it
 * cannot carry the key; it goes on without one and only reaches the CORS
 * middleware, which answers every `OPTIONS` before any route runs.
 */
function isPreflight(frame: HttpRequestFrame): boolean {
  return (
    frame.method.toUpperCase() === 'OPTIONS' &&
    frame.headers.some(([name]) => name.toLowerCase() === 'access-control-request-method')
  )
}

/** The largest `http.body` payload, so every encoded frame stays far below `MAX_TUNNEL_FRAME_BYTES`. */
export const MAX_BODY_CHUNK_BYTES = 64 * 1024

const encoder = new TextEncoder()

/**
 * Builds the `Request` for an `http.request` frame, or returns null when it
 * must not reach the host: a path whose dot segments leave `/api/`, a GET or
 * HEAD with a body, or a frame the `Request` constructor rejects.
 */
export function tunneledRequest(frame: HttpRequestFrame, signal?: AbortSignal): Request | null {
  try {
    // Joined as strings, so the path is never resolved against the origin as a relative URL.
    const url = new URL(HOST_ORIGIN + frame.path)
    // URL parsing resolves `..` and `%2e%2e`, so check what it made of the path.
    if (!url.pathname.startsWith(`${API_PREFIX}/`)) return null
    const body = frame.body?.byteLength ? frame.body : undefined
    const request = new Request(url.href, { method: frame.method, headers: frame.headers, body, signal })
    // The fetch standard forbids a body here, but Bun's `Request` accepts one.
    if (body && (request.method === 'GET' || request.method === 'HEAD')) return null
    return request
  } catch {
    return null
  }
}

/**
 * Serves the `http.request` frames of one tunnel connection through `handle`,
 * once `authorize` has accepted the request's access key, streaming each response back as `http.response`, `http.body` and `http.end`.
 * Each body chunk waits for `room`, so a large response is read only as fast
 * as the tunnel takes it. After `close()` it writes nothing more, so a dropped
 * connection's requests never reach the next one. A request without a valid
 * key gets `auth.failed`, then a 401, and never reaches `handle`.
 */
export class TunnelHttp {
  private readonly inFlight = new Map<number, AbortController>()
  private closed = false

  constructor(
    private readonly handle: TunnelHandler,
    private readonly authorize: Authorize,
    private readonly send: (frame: MachineFrame) => void,
    private readonly room: () => Promise<void> = () => Promise.resolve(),
  ) {}

  /** Starts answering `frame`. A frame whose `id` is already in flight is ignored. */
  request(frame: HttpRequestFrame) {
    if (this.closed || this.inFlight.has(frame.id)) return
    const controller = new AbortController()
    this.inFlight.set(frame.id, controller)
    void this.serve(frame, controller.signal).finally(() => {
      if (this.inFlight.get(frame.id) === controller) this.inFlight.delete(frame.id)
    })
  }

  /** Aborts every request in flight and drops anything they would still send. */
  close() {
    this.closed = true
    for (const controller of this.inFlight.values()) controller.abort()
    this.inFlight.clear()
  }

  private async serve(frame: HttpRequestFrame, signal: AbortSignal) {
    const { id } = frame
    const send = (out: MachineFrame) => {
      if (!signal.aborted) this.send(out)
    }
    const fail = (status: number) => {
      send({ type: 'http.response', id, status, headers: [] })
      send({ type: 'http.end', id })
    }

    let principal: Principal | null = null
    if (!isPreflight(frame)) {
      principal = this.authorize(accessKeyOf(frame.headers))
      if (!principal) {
        // First, so the server still knows the request's browser when it reads it.
        send({ type: 'auth.failed', id })
        return fail(401)
      }
    }
    // The key has done its job, so no handler ever sees it.
    const headers = frame.headers.filter(([name]) => name.toLowerCase() !== ACCESS_KEY_HEADER)
    const request = tunneledRequest({ ...frame, headers }, signal)
    if (!request) return fail(400)
    let response: Response
    try {
      response = await this.handle(request, principal)
    } catch {
      return fail(500)
    }
    if (signal.aborted) {
      await response.body?.cancel().catch(() => {})
      return
    }

    send({ type: 'http.response', id, status: response.status, headers: [...response.headers] })
    if (!response.body) return send({ type: 'http.end', id })

    const reader = response.body.getReader()
    const cancel = () => void reader.cancel().catch(() => {})
    signal.addEventListener('abort', cancel, { once: true })
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done || signal.aborted) break
        const bytes: Uint8Array<ArrayBuffer> = typeof value === 'string' ? encoder.encode(value) : value
        for (let start = 0; start < bytes.byteLength; start += MAX_BODY_CHUNK_BYTES) {
          await this.room()
          if (signal.aborted) break
          send({ type: 'http.body', id, data: bytes.subarray(start, start + MAX_BODY_CHUNK_BYTES) })
        }
      }
      send({ type: 'http.end', id })
    } catch {
      send({ type: 'http.end', id, error: 'response body failed' })
    } finally {
      signal.removeEventListener('abort', cancel)
    }
  }
}
