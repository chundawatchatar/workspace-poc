import {
  ACCESS_KEY_HEADER,
  buildRequest,
  CLOSE_ACCESS_DENIED,
  CLOSE_DEVICE_NOT_APPROVED,
  DEVICE_NOT_APPROVED_CODE,
  DEVICE_PROOF_HEADER,
  DEVICE_PROOF_SOCKET_METHOD,
  E2eError,
  type E2eSession,
  machinePathPrefix,
  openE2eSessionResponse,
  RELAY_TICKET_HEADER,
  type RelayTicketResponse,
  relaySocketProtocols,
  routes,
  type SocketAuthMessage,
  startBrowserHandshake,
} from '@orch/shared'
import { createDeviceProof, type DeviceSigner } from './lib/deviceProof'
import { type OpenLater, pendingSocket } from './lib/pendingSocket'

export type { DeviceSigner } from './lib/deviceProof'

/**
 * How the page reaches a host. Every request and socket the page makes goes through one of these, so the same page
 * can talk to the local host or to a remote machine.
 */
export interface HostTransport {
  /** Sends a request for a path built by `buildRequest` (a route path with its query string). */
  request(path: string, init: RequestInit): Promise<Response>
  /** Opens a socket for a path built by `buildSocketUrl` (a socket path with its query string). */
  openSocket(path: string): WebSocket
}

/** A transport that talks to a host directly at `baseUrl`, such as `http://localhost:4599`. */
export function createLocalTransport(baseUrl: string): HostTransport {
  const http = baseUrl.replace(/\/$/, '')
  const ws = http.replace(/^http/, 'ws')
  return {
    request: (path, init) => fetch(`${http}${path}`, init),
    openSocket: (path) => new WebSocket(`${ws}${path}`),
  }
}

/**
 * Gets a relay ticket that opens the machine as the signed-in account for a minute. Null means the account can't
 * open it (it doesn't list the machine); a rejection is a failure worth retrying.
 */
export type RelayTicketSource = () => Promise<RelayTicketResponse | null>

export interface RemoteTransportOptions {
  /** The cloud server, such as `https://example.com`. Only `http:` and `https:` are accepted. */
  serverUrl: string
  machineId: string
  /** The machine's access key. It goes in a header or the first socket message, never in a URL, with a device proof. */
  accessKey?: string
  /**
   * Used when there is no `accessKey`: the signed-in account opens the machine with relay tickets, which go in a
   * header or a socket's subprotocols, never in a URL or a cookie.
   */
  relayTicket?: RelayTicketSource
  /**
   * This browser's device key, which both modes need: every request and socket also carries a fresh proof signed
   * with it, and the machine admits only a device its owner approved there.
   */
  device?: DeviceSigner
  /**
   * The machine's Ed25519 public key, as this browser pinned it. With it, nothing is sent before an end-to-end session
   * with the machine is open, and the machine's answer must be signed with this key.
   */
  machinePublicKey?: string
  /** Called once when the machine's answer to the handshake doesn't verify, so the page stops. */
  onMachineUnverified?: () => void
}

// The methods `fetch` sends in upper case whatever their case here; any other goes as written.
const NORMALIZED_METHODS = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'POST', 'PUT'])

/** The method `fetch` sends for `init`, as a proof must name it. */
function sentMethod(init: RequestInit): string {
  const method = init.method ?? 'GET'
  return NORMALIZED_METHODS.has(method.toUpperCase()) ? method.toUpperCase() : method
}

// A cached ticket or end-to-end session is replaced this long before it expires, so a request never reaches the
// machine with a dead one.
const TICKET_MARGIN_MS = 15_000

/** How the transport opens what it carries: a request, or the real socket behind a `pendingSocket`. */
interface Channels {
  request(path: string, init: RequestInit): Promise<Response>
  openLater(path: string): OpenLater
}

/**
 * A transport that reaches a machine through the cloud server, under `machinePathPrefix(machineId)`. With a key,
 * requests carry it in `ACCESS_KEY_HEADER`. Without one, they carry a relay ticket in `RELAY_TICKET_HEADER`, one
 * ticket shared until shortly before it expires, and each socket opens with a fresh ticket as its second
 * subprotocol. Either way every request also carries a fresh device proof in `DEVICE_PROOF_HEADER`, and every socket
 * sends `socketAuthMessage` as its first message, ahead of anything the page sends from its own `onopen`: the key, or
 * `account: true`, with a fresh `'WS'` device proof. Only string or absent request bodies are accepted, since the
 * proof signs the body. With `machinePublicKey`, nothing is sent before an end-to-end session with the machine is
 * open; see `withE2eSession`.
 */
export function createRemoteTransport({
  serverUrl,
  machineId,
  accessKey,
  relayTicket,
  device,
  machinePublicKey,
  onMachineUnverified,
}: RemoteTransportOptions): HostTransport {
  const server = new URL(serverUrl)
  if (server.protocol !== 'http:' && server.protocol !== 'https:') {
    throw new Error(`The server URL must use http: or https:, not ${server.protocol}`)
  }
  const http = `${server.origin}${server.pathname.replace(/\/$/, '')}${machinePathPrefix(machineId)}`
  const ws = http.replace(/^http/, 'ws')
  if (!accessKey && !relayTicket) throw new Error('A remote transport needs an access key or a relay ticket source')
  if (!device) throw new Error('A remote transport needs a device key')
  const signer = device
  /** Throws for a body a proof can't sign: only string or absent bodies are accepted. */
  const signedBody = ({ body }: RequestInit): string => {
    if (body != null && typeof body !== 'string') throw new Error('A remote request needs a string body')
    return body ?? ''
  }
  const requestProof = (path: string, init: RequestInit, body: string) =>
    createDeviceProof(signer, { machineId, method: sentMethod(init), path, body })
  const socketProof = (path: string) =>
    createDeviceProof(signer, { machineId, method: DEVICE_PROOF_SOCKET_METHOD, path })
  /** A socket that sends `auth` first: the page can only set `onopen` once `pendingSocket` hands it over. */
  const authedSocket = (path: string, auth: SocketAuthMessage, protocols?: string[]) => {
    const socket = new WebSocket(`${ws}${path}`, protocols)
    const message = JSON.stringify(auth)
    socket.addEventListener('open', () => socket.send(message), { once: true })
    return socket
  }

  let channels: Channels
  if (accessKey) {
    channels = {
      request: async (path, init) => {
        const proof = await requestProof(path, init, signedBody(init))
        const headers = new Headers(init.headers)
        headers.set(ACCESS_KEY_HEADER, accessKey)
        headers.set(DEVICE_PROOF_HEADER, proof)
        return fetch(`${http}${path}`, { ...init, headers })
      },
      openLater: (path) => async () =>
        authedSocket(path, { type: 'auth', key: accessKey, device: await socketProof(path) }),
    }
  } else {
    const tickets = relayTicket as RelayTicketSource
    let cached: RelayTicketResponse | null = null
    let fetching: Promise<RelayTicketResponse | null> | null = null
    const httpTicket = async () => {
      if (cached && Date.parse(cached.expiresAt) - Date.now() > TICKET_MARGIN_MS) return cached.ticket
      // Requests that arrive together wait for the same new ticket.
      fetching ??= tickets().finally(() => {
        fetching = null
      })
      cached = await fetching
      return cached?.ticket ?? null
    }
    channels = {
      request: async (path, init) => {
        const body = signedBody(init)
        const ticket = await httpTicket()
        // The account can't open this machine, which the machine itself would answer with 401 too.
        if (!ticket) return new Response(null, { status: 401 })
        const proof = await requestProof(path, init, body)
        const headers = new Headers(init.headers)
        headers.set(RELAY_TICKET_HEADER, ticket)
        headers.set(DEVICE_PROOF_HEADER, proof)
        return fetch(`${http}${path}`, { ...init, headers })
      },
      openLater: (path) => async () => {
        // A fresh ticket per socket: the machine lets each ticket open only one.
        const fresh = await tickets()
        if (!fresh) return CLOSE_ACCESS_DENIED
        const auth: SocketAuthMessage = { type: 'auth', account: true, device: await socketProof(path) }
        return authedSocket(path, auth, relaySocketProtocols(fresh.ticket))
      },
    }
  }

  const carried = machinePublicKey
    ? withE2eSession(channels, { machineId, signer, machinePublicKey, onMachineUnverified })
    : channels
  return {
    request: carried.request,
    openSocket: (path) => pendingSocket(`${ws}${path}`, carried.openLater(path)),
  }
}

/** An open end-to-end session, as later jobs seal with it. `expiresAt` is in epoch milliseconds. */
interface OpenSession {
  sessionId: string
  session: E2eSession
  expiresAt: number
}

/** How a handshake the machine refused ended: its status and body, so each waiting call gets a fresh `Response`. */
interface Refused {
  status: number
  statusText: string
  headers: [string, string][]
  body: string
}

/**
 * Wraps `channels` so the first request or socket, and the first after the session nears its expiry, first opens an
 * end-to-end session: a hello signed with the device key is posted to `routes.e2e.open` through `channels`, with the
 * same key or ticket and a device proof, and the machine's answer is checked against `machinePublicKey`. Calls that
 * arrive together share one handshake. A refused handshake answers each request with its status, and fails each
 * socket with the close code the page knows, and the next call tries again. An answer that doesn't verify (another
 * key, another hello, a bad shape, or a browser without the WebCrypto it needs) calls `onMachineUnverified` once, and
 * from then on every call fails with `E2eError` without reaching the machine.
 */
function withE2eSession(
  channels: Channels,
  options: { machineId: string; signer: DeviceSigner; machinePublicKey: string; onMachineUnverified?: () => void },
): Channels {
  let current: OpenSession | null = null
  let opening: Promise<Refused | null> | null = null
  let unverified: E2eError | null = null

  const handshake = async (): Promise<Refused | null> => {
    const started = await startBrowserHandshake({ machineId: options.machineId, device: options.signer })
    const { url, body } = buildRequest(routes.e2e.open, started.hello)
    const response = await channels.request(url, {
      method: routes.e2e.open.method,
      headers: { 'content-type': 'application/json' },
      body,
    })
    if (!response.ok) {
      const { status, statusText } = response
      return { status, statusText, headers: [...response.headers], body: await response.text().catch(() => '') }
    }
    try {
      const answer = openE2eSessionResponse.parse(await response.json())
      const session = await started.finish(answer.hello, options.machinePublicKey)
      current = { sessionId: answer.sessionId, session, expiresAt: Date.parse(answer.expiresAt) }
      return null
    } catch (error) {
      unverified = error instanceof E2eError ? error : new E2eError('bad message')
      options.onMachineUnverified?.()
      throw new E2eError(unverified.reason)
    }
  }

  /** Null once a session is open, or how the machine refused the handshake. Rejects when the machine is unverified. */
  const ensureSession = async (): Promise<Refused | null> => {
    if (unverified) throw new E2eError(unverified.reason)
    if (current && current.expiresAt - Date.now() > TICKET_MARGIN_MS) return null
    opening ??= handshake().finally(() => {
      opening = null
    })
    return opening
  }

  return {
    request: async (path, init) => {
      const refused = await ensureSession()
      if (refused) return new Response(refused.body, refused)
      return channels.request(path, init)
    },
    openLater: (path) => async () => {
      const refused = await ensureSession()
      if (refused) return closeCodeFor(refused)
      return channels.openLater(path)()
    },
  }
}

/** The close code a socket fails with when the handshake before it was refused, as the page reads them. */
function closeCodeFor({ status, body }: Refused): number {
  if (status === 401) return CLOSE_ACCESS_DENIED
  if (status === 403 && refusalCode(body) === DEVICE_NOT_APPROVED_CODE) return CLOSE_DEVICE_NOT_APPROVED
  return 1006
}

function refusalCode(body: string): unknown {
  try {
    return (JSON.parse(body) as { code?: unknown } | null)?.code
  } catch {
    return undefined
  }
}
