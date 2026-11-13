import { createHash } from 'node:crypto'
import {
  ACCESS_KEY_HEADER,
  API_PREFIX,
  type AuditRefusalReason,
  DEVICE_NOT_APPROVED_CODE,
  DEVICE_PROOF_HEADER,
  decodeEnvelope,
  decodeRequestRecord,
  E2E_SESSION_UNKNOWN_CODE,
  type E2eChannel,
  type E2eEnvelope,
  type E2eHttpRequest,
  type E2eHttpResponseRecord,
  type E2eSession,
  encodeResponseRecord,
  frameRecord,
  type httpRequestFrame,
  type httpSealedFrame,
  type MachineFrame,
  RELAY_TICKET_HEADER,
} from '@orch/shared'
import type { z } from 'zod'
import { HOST_ORIGIN } from '../../lib/localOrigin'
import type { Principal } from '../../lib/principal'
import type { RecordAudit } from '../remote-access/audit-log.service'

type HttpRequestFrame = z.infer<typeof httpRequestFrame>
type HttpSealedFrame = z.infer<typeof httpSealedFrame>

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
 * What a request or channel presents: its access key or a relay ticket the
 * server signed for an account, plus a device proof. A caller sets a key or a
 * ticket, and a key always decides which is used. `once` spends the ticket, so
 * it can't open another socket.
 */
export interface Credentials {
  key: string | null
  ticket: string | null
  /** Null means no proof came with the key or ticket. */
  device?: PresentedProof | null
  once?: boolean
}

/** What `Authorize` answers for a valid key or ticket and proof from a device the machine hasn't approved. */
export const DEVICE_NOT_APPROVED = 'device_not_approved'

/** Who a request or channel is, `DEVICE_NOT_APPROVED`, or null for refused. */
export type Authorization = Principal | typeof DEVICE_NOT_APPROVED | null

/** Why `Authorize` refused, for the audit log. */
export interface Refusal {
  reason: AuditRefusalReason
  /** The device whose proof verified, and what it came as. Absent when no proof verified. */
  device?: { id: string; principal: Principal['kind'] }
}

/**
 * Decides whether a request or channel may in. In the host this is
 * `RemoteAccessService`'s, which checks a key with `AccessKeys.authorize`, or
 * a ticket against the linked account and the server's public keys, either
 * one together with a proof from an approved device. When it answers null or
 * `DEVICE_NOT_APPROVED`, it tells `refused` why.
 */
export type Authorize = (credentials: Credentials, refused?: (refusal: Refusal) => void) => Authorization

/**
 * Decides with `authorize`, and says why it refused. When `authorize` gives
 * no reason, a refused key counts as `key_refused` and anything else as
 * `ticket_refused`.
 */
export function authorizeWithReason(
  authorize: Authorize,
  credentials: Credentials,
): { authorization: Authorization; refusal: Refusal | null } {
  // Set in the callback, which TypeScript can't follow, so the type is named.
  let refusal = null as Refusal | null
  const authorization = authorize(credentials, (given) => {
    refusal = given
  })
  if (authorization !== null && authorization !== DEVICE_NOT_APPROVED) return { authorization, refusal: null }
  const fallback: Refusal['reason'] =
    authorization === DEVICE_NOT_APPROVED
      ? 'device_not_approved'
      : credentials.key !== null
        ? 'key_refused'
        : 'ticket_refused'
  return { authorization, refusal: refusal ?? { reason: fallback } }
}

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
 * What an `http.request` presents, with its one `DEVICE_PROOF_HEADER` for the
 * frame's method, path and body. With any `ACCESS_KEY_HEADER` the key is the
 * credential, so a missing or wrong key is never rescued by a ticket; without
 * one, its one `RELAY_TICKET_HEADER` is.
 */
export function requestCredentials({ headers, method, path, body }: HttpRequestFrame): Credentials {
  const proof = singleHeader(headers, DEVICE_PROOF_HEADER)
  const device = proof ? { proof, method, path, bodySha256: bodySha256(body) } : null
  const hasKey = headers.some(([name]) => name.toLowerCase() === ACCESS_KEY_HEADER)
  if (hasKey) return { key: accessKeyOf(headers), ticket: null, device }
  return { key: null, ticket: singleHeader(headers, RELAY_TICKET_HEADER), device }
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

/** What a sealed request needs from the session it names: who opened it, and its channels. */
export interface SealedSession {
  principal: Principal
  session: Pick<E2eSession, 'channel'>
}

/**
 * Finds the end-to-end session a sealed request names, from the host's own
 * records and expiry, or null when there is none. In the host this is
 * `E2eSessions.get`.
 */
export type SealedSessionLookup = (sessionId: string) => SealedSession | null

/** True when `a` and `b` are the same access: the same kind, device, and key or account. */
export function samePrincipal(a: Principal, b: Principal): boolean {
  if (a.kind !== b.kind || a.deviceId !== b.deviceId) return false
  return a.kind === 'key'
    ? b.kind === 'key' && a.keyId === b.keyId
    : b.kind === 'account' && a.accountId === b.accountId
}

/** Where a response goes: straight into frames, or sealed into records on a channel. Each step may wait. */
interface ResponseWriter {
  head(status: number, headers: [string, string][]): Promise<void>
  /** One chunk of at most `MAX_BODY_CHUNK_BYTES`, sent once the tunnel has `room` for it. */
  body(data: Uint8Array<ArrayBuffer>): Promise<void>
  end(error?: string): Promise<void>
}

/** A request, plain or opened from its seal, as the tunnel authorizes and serves it. */
type InnerRequest = Omit<HttpRequestFrame, 'type'>

/**
 * Serves the `http.request` and `http.sealed` frames of one tunnel connection
 * through `handle`, once `authorize` has accepted the request's access key or
 * relay ticket, streaming each response back as `http.response`, `http.body`
 * and `http.end`. Each body chunk waits for `room`, so a large response is read
 * only as fast as the tunnel takes it. After `close()` it writes nothing more,
 * so a dropped connection's requests never reach the next one. A request
 * refused by `authorize` gets `auth.failed`, then a 401, and never reaches
 * `handle`; one from a device that isn't approved gets a JSON 403
 * `device_not_approved` and no `auth.failed`. Each refused request is recorded
 * with its reason. A sealed request is opened on its own channel of the
 * session it names, authorized the same way from its own credentials, refused
 * with 403 unless that is the session's principal, and answered with sealed
 * records on the same channel; see `sealed`.
 */
export class TunnelHttp {
  private readonly inFlight = new Map<number, AbortController>()
  private closed = false

  constructor(
    private readonly handle: TunnelHandler,
    private readonly authorize: Authorize,
    private readonly send: (frame: MachineFrame) => void,
    private readonly room: () => Promise<void> = () => Promise.resolve(),
    /** Where refused requests are recorded. Accepted ones are not. */
    private readonly record: RecordAudit = () => {},
    /** Finds the session a sealed request names. Without one, every sealed request gets the unsealed 409. */
    private readonly sessions: SealedSessionLookup = () => null,
  ) {}

  /** Starts answering `frame`. A frame whose `id` is already in flight is ignored. */
  request(frame: HttpRequestFrame) {
    this.track(frame.id, (signal) => this.serve(frame, this.plainWriter(frame.id, signal), signal))
  }

  /**
   * Starts answering a sealed request: it reads the envelope, looks its session
   * up, opens the channel and its request record, then serves it like
   * `request`, sealing the head, each body chunk and an end record on that
   * channel. Each record goes as one length-prefixed `http.body` under an
   * unsealed `http.response` 200. A session the host doesn't have gets an
   * unsealed 409 `e2e_session_unknown`, and a malformed envelope, a channel
   * already taken or a record that fails to open an unsealed 400. A frame whose
   * `id` is already in flight is ignored.
   */
  sealed(frame: HttpSealedFrame) {
    this.track(frame.id, (signal) => this.serveSealed(frame, signal))
  }

  /** Aborts every request in flight and drops anything they would still send. */
  close() {
    this.closed = true
    for (const controller of this.inFlight.values()) controller.abort()
    this.inFlight.clear()
  }

  private track(id: number, run: (signal: AbortSignal) => Promise<void>) {
    if (this.closed || this.inFlight.has(id)) return
    const controller = new AbortController()
    this.inFlight.set(id, controller)
    void run(controller.signal).finally(() => {
      if (this.inFlight.get(id) === controller) this.inFlight.delete(id)
    })
  }

  /** Sends `out` unless the request was aborted. */
  private sender(signal: AbortSignal) {
    return (out: MachineFrame) => {
      if (!signal.aborted) this.send(out)
    }
  }

  /** Writes a response as plain frames. */
  private plainWriter(id: number, signal: AbortSignal): ResponseWriter {
    const send = this.sender(signal)
    return {
      head: async (status, headers) => send({ type: 'http.response', id, status, headers }),
      body: async (data) => {
        await this.room()
        send({ type: 'http.body', id, data })
      },
      end: async (error) => send(error === undefined ? { type: 'http.end', id } : { type: 'http.end', id, error }),
    }
  }

  /** Writes a response as records sealed in order on `channel`, inside a plain 200. */
  private sealedWriter(id: number, channel: E2eChannel, signal: AbortSignal): ResponseWriter {
    const send = this.sender(signal)
    const sealRecord = async (record: E2eHttpResponseRecord) => {
      const sealed = await channel.seal(encodeResponseRecord(record))
      await this.room()
      send({ type: 'http.body', id, data: frameRecord(sealed) })
    }
    return {
      head: async (status, headers) => {
        send({ type: 'http.response', id, status: 200, headers: [['content-type', 'application/octet-stream']] })
        await sealRecord({ kind: 'head', head: { status, headers } })
      },
      body: (data) => sealRecord({ kind: 'body', data }),
      end: async (error) => {
        await sealRecord(error === undefined ? { kind: 'end' } : { kind: 'end', error })
        send({ type: 'http.end', id })
      },
    }
  }

  private async serveSealed(frame: HttpSealedFrame, signal: AbortSignal) {
    const { id } = frame
    const plain = this.plainWriter(id, signal)
    const refuse = async (status: number, body?: object) => {
      if (!body) return writeAll(plain, status, [])
      await writeAll(plain, status, [['content-type', 'application/json']], encoder.encode(JSON.stringify(body)))
    }

    let envelope: E2eEnvelope
    try {
      envelope = decodeEnvelope(frame.data)
    } catch {
      return refuse(400)
    }
    const entry = this.sessions(envelope.sessionId)
    if (!entry) {
      return refuse(409, { error: 'The end-to-end session is unknown', code: E2E_SESSION_UNKNOWN_CODE })
    }
    let channel: E2eChannel
    let inner: E2eHttpRequest
    try {
      channel = await entry.session.channel(envelope.channel)
      inner = decodeRequestRecord(await channel.open(envelope.sealed))
    } catch {
      return refuse(400)
    }
    if (signal.aborted) return

    const writer = this.sealedWriter(id, channel, signal)
    const request: InnerRequest = {
      id,
      method: inner.method,
      path: inner.path,
      headers: inner.headers,
      ...(inner.body ? { body: encoder.encode(inner.body) } : {}),
    }
    try {
      await this.serve(request, writer, signal, (principal) => samePrincipal(principal, entry.principal))
    } catch {
      // Sealing failed, so the browser can't get a sealed end; an unfinished outer body tells it.
      plain.end('response failed')
    }
  }

  /**
   * Authorizes `frame` and answers it through `writer`. With `matches`, an
   * authorized principal it refuses gets a 403 and never reaches `handle`.
   */
  private async serve(
    frame: InnerRequest,
    writer: ResponseWriter,
    signal: AbortSignal,
    matches?: (principal: Principal) => boolean,
  ) {
    const { id } = frame
    const fail = (status: number) => writeAll(writer, status, [])
    const refuseJson = (body: object) =>
      writeAll(writer, 403, [['content-type', 'application/json']], encoder.encode(JSON.stringify(body)))

    // Preflights included: the server answers those itself, so one that gets here is an ordinary request.
    const { authorization: principal, refusal } = authorizeWithReason(
      this.authorize,
      requestCredentials({ type: 'http.request', ...frame }),
    )
    if (refusal) this.record({ kind: 'refused', ...refusal })
    if (!principal) {
      // First, and never sealed, so the server still knows the request's browser when it reads it.
      this.sender(signal)({ type: 'auth.failed', id })
      return fail(401)
    }
    if (principal === DEVICE_NOT_APPROVED) {
      // Not a bad credential: the browser waits for its owner, so the server's bad-key limit isn't charged.
      return refuseJson({ error: 'This browser is not approved on this machine', code: DEVICE_NOT_APPROVED_CODE })
    }
    if (matches && !matches(principal)) {
      return refuseJson({ error: 'This request is not from the access that opened its end-to-end session' })
    }
    // The key, ticket and proof have done their job, so no handler ever sees them.
    const headers = frame.headers.filter(([name]) => !CREDENTIAL_HEADERS.has(name.toLowerCase()))
    const request = tunneledRequest({ type: 'http.request', ...frame, headers }, signal)
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

    await writer.head(response.status, [...response.headers])
    if (!response.body) return writer.end()

    const reader = response.body.getReader()
    const cancel = () => void reader.cancel().catch(() => {})
    signal.addEventListener('abort', cancel, { once: true })
    let failed = false
    try {
      while (true) {
        const chunk = await reader.read().catch(() => null)
        if (!chunk) {
          failed = true
          break
        }
        const { done, value } = chunk
        if (done || signal.aborted) break
        const bytes: Uint8Array<ArrayBuffer> = typeof value === 'string' ? encoder.encode(value) : value
        for (let start = 0; start < bytes.byteLength; start += MAX_BODY_CHUNK_BYTES) {
          if (signal.aborted) break
          await writer.body(bytes.subarray(start, start + MAX_BODY_CHUNK_BYTES))
        }
      }
    } finally {
      signal.removeEventListener('abort', cancel)
    }
    await writer.end(failed ? 'response body failed' : undefined)
  }
}

/** Writes a whole response with an optional one-chunk body. */
async function writeAll(
  writer: ResponseWriter,
  status: number,
  headers: [string, string][],
  body?: Uint8Array<ArrayBuffer>,
) {
  await writer.head(status, headers)
  if (body) await writer.body(body)
  await writer.end()
}
