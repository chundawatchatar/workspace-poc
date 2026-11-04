import { createHash } from 'node:crypto'
import {
  ACCESS_KEY_HEADER,
  API_PREFIX,
  DEVICE_NOT_APPROVED_CODE,
  DEVICE_PROOF_HEADER,
  type httpRequestFrame,
  type MachineFrame,
  RELAY_TICKET_HEADER,
} from '@orch/shared'
import type { z } from 'zod'
import { HOST_ORIGIN } from '../../lib/localOrigin'
import type { Principal } from '../../lib/principal'

type HttpRequestFrame = z.infer<typeof httpRequestFrame>

/** Answers one tunneled request, as the principal that authorized it. In the host this is `app.fetch`. */
export type TunnelHandler = (request: Request, principal: Principal) => Promise<Response>

/** A device proof, with what the request it came with must match. */
export interface PresentedProof {
  proof: string
  /** The HTTP method, or `'WS'` for a socket. */
  method: string
  /** The host path with its query string. */
  path: string
  /** The base64url SHA-256 of the body, or of the empty string. */
  bodySha256: string
}

/**
 * What a request or channel presents: its access key, or a relay ticket the
 * server signed for an account plus a device proof. A caller sets a key or a
 * ticket, and a key always wins. `once` spends the ticket, so it can't open
 * another socket.
 */
export interface Credentials {
  key: string | null
  ticket: string | null
  /** Null means no proof came with the ticket. */
  device?: PresentedProof | null
  once?: boolean
}

/** What `Authorize` answers for a valid ticket and proof from a device the machine hasn't approved. */
export const DEVICE_NOT_APPROVED = 'device_not_approved'

/** Who a request or channel is, `DEVICE_NOT_APPROVED`, or null for refused. */
export type Authorization = Principal | typeof DEVICE_NOT_APPROVED | null

/**
 * Decides whether a request or channel may in. In the host this is
 * `RemoteAccessService`'s, which checks a key with `AccessKeys.authorize`, and
 * a ticket against the linked account and the server's public keys together
 * with a proof from an approved device.
 */
export type Authorize = (credentials: Credentials) => Authorization

/** The base64url SHA-256 of `data`, as a device proof's `bodySha256`. */
export function bodySha256(data: Uint8Array | string = ''): string {
  return createHash('sha256').update(data).digest('base64url')
}

/** The value of the one header named `name`, or null when there is none or more than one. */
function singleHeader(headers: [string, string][], name: string): string | null {
  const values = headers.filter(([header]) => header.toLowerCase() === name)
  return values.length === 1 ? (values[0]?.[1] ?? null) : null
}

/**
 * What an `http.request` presents. With any `ACCESS_KEY_HEADER` the key alone
 * decides, so a missing or wrong key is never rescued by a ticket; without
 * one, its one `RELAY_TICKET_HEADER` does, with its one `DEVICE_PROOF_HEADER`
 * for the frame's method, path and body.
 */
export function requestCredentials({ headers, method, path, body }: HttpRequestFrame): Credentials {
  const hasKey = headers.some(([name]) => name.toLowerCase() === ACCESS_KEY_HEADER)
  if (hasKey) return { key: accessKeyOf(headers), ticket: null }
  const proof = singleHeader(headers, DEVICE_PROOF_HEADER)
  return {
    key: null,
    ticket: singleHeader(headers, RELAY_TICKET_HEADER),
    device: proof ? { proof, method, path, bodySha256: bodySha256(body) } : null,
  }
}

/**
 * The access key of a request: the value of its one `ACCESS_KEY_HEADER`, or
 * null when there is none or more than one. Never read from the query string.
 */
export function accessKeyOf(headers: [string, string][]): string | null {
  return singleHeader(headers, ACCESS_KEY_HEADER)
}

/** The largest `http.body` payload, so every encoded frame stays far below `MAX_TUNNEL_FRAME_BYTES`. */
export const MAX_BODY_CHUNK_BYTES = 64 * 1024

const encoder = new TextEncoder()

/** The headers that carry credentials, stripped before a handler sees the request. */
const CREDENTIAL_HEADERS = new Set([ACCESS_KEY_HEADER, RELAY_TICKET_HEADER, DEVICE_PROOF_HEADER])

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
 * once `authorize` has accepted the request's access key or relay ticket, streaming
 * each response back as `http.response`, `http.body` and `http.end`.
 * Each body chunk waits for `room`, so a large response is read only as fast
 * as the tunnel takes it. After `close()` it writes nothing more, so a dropped
 * connection's requests never reach the next one. A request refused by
 * `authorize` gets `auth.failed`, then a 401, and never reaches `handle`; one
 * from a device that isn't approved gets a JSON 403 `device_not_approved`
 * and no `auth.failed`.
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

    // Preflights included: the server answers those itself, so one that gets here is an ordinary request.
    const principal = this.authorize(requestCredentials(frame))
    if (!principal) {
      // First, so the server still knows the request's browser when it reads it.
      send({ type: 'auth.failed', id })
      return fail(401)
    }
    if (principal === DEVICE_NOT_APPROVED) {
      // Not a bad credential: the browser waits for its owner, so the server's bad-key limit isn't charged.
      const body = encoder.encode(
        JSON.stringify({ error: 'This browser is not approved on this machine', code: DEVICE_NOT_APPROVED_CODE }),
      )
      send({ type: 'http.response', id, status: 403, headers: [['content-type', 'application/json']] })
      send({ type: 'http.body', id, data: body })
      return send({ type: 'http.end', id })
    }
    // The key, ticket and proof have done their job, so no handler ever sees them.
    const headers = frame.headers.filter(([name]) => !CREDENTIAL_HEADERS.has(name.toLowerCase()))
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
