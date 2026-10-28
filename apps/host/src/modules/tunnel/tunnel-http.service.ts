import { API_PREFIX, type httpRequestFrame, type MachineFrame } from '@orch/shared'
import type { z } from 'zod'
import { HOST_ORIGIN } from '../../lib/localOrigin'

type HttpRequestFrame = z.infer<typeof httpRequestFrame>

/** Answers one tunneled request. In the host this is `app.fetch`. */
export type TunnelHandler = (request: Request) => Promise<Response>

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
 * streaming each response back as `http.response`, `http.body` and `http.end`.
 * Each body chunk waits for `room`, so a large response is read only as fast
 * as the tunnel takes it. After `close()` it writes nothing more, so a dropped
 * connection's requests never reach the next one.
 */
export class TunnelHttp {
  private readonly inFlight = new Map<number, AbortController>()
  private closed = false

  constructor(
    private readonly handle: TunnelHandler,
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

    const request = tunneledRequest(frame, signal)
    if (!request) return fail(400)
    let response: Response
    try {
      response = await this.handle(request)
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
