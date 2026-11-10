import {
  ACCESS_KEY_HEADER,
  CLOSE_ACCESS_DENIED,
  DEVICE_PROOF_HEADER,
  DEVICE_PROOF_SOCKET_METHOD,
  machinePathPrefix,
  RELAY_TICKET_HEADER,
  type RelayTicketResponse,
  relaySocketProtocols,
  type SocketAuthMessage,
} from '@orch/shared'
import { createDeviceProof, type DeviceSigner } from './lib/deviceProof'
import { pendingSocket } from './lib/pendingSocket'

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
}

// The methods `fetch` sends in upper case whatever their case here; any other goes as written.
const NORMALIZED_METHODS = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'POST', 'PUT'])

/** The method `fetch` sends for `init`, as a proof must name it. */
function sentMethod(init: RequestInit): string {
  const method = init.method ?? 'GET'
  return NORMALIZED_METHODS.has(method.toUpperCase()) ? method.toUpperCase() : method
}

// A cached ticket is replaced this long before it expires, so a request never reaches the machine with a dead one.
const TICKET_MARGIN_MS = 15_000

/**
 * A transport that reaches a machine through the cloud server, under `machinePathPrefix(machineId)`. With a key,
 * requests carry it in `ACCESS_KEY_HEADER`. Without one, they carry a relay ticket in `RELAY_TICKET_HEADER`, one
 * ticket shared until shortly before it expires, and each socket opens with a fresh ticket as its second
 * subprotocol. Either way every request also carries a fresh device proof in `DEVICE_PROOF_HEADER`, and every socket
 * sends `socketAuthMessage` as its first message, ahead of anything the page sends from its own `onopen`: the key, or
 * `account: true`, with a fresh `'WS'` device proof. Only string or absent request bodies are accepted, since the
 * proof signs the body.
 */
export function createRemoteTransport({
  serverUrl,
  machineId,
  accessKey,
  relayTicket,
  device,
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

  if (accessKey) {
    return {
      request: async (path, init) => {
        const proof = await requestProof(path, init, signedBody(init))
        const headers = new Headers(init.headers)
        headers.set(ACCESS_KEY_HEADER, accessKey)
        headers.set(DEVICE_PROOF_HEADER, proof)
        return fetch(`${http}${path}`, { ...init, headers })
      },
      openSocket: (path) =>
        pendingSocket(`${ws}${path}`, async () =>
          authedSocket(path, { type: 'auth', key: accessKey, device: await socketProof(path) }),
        ),
    }
  }
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
  return {
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
    openSocket: (path) =>
      pendingSocket(`${ws}${path}`, async () => {
        // A fresh ticket per socket: the machine lets each ticket open only one.
        const fresh = await tickets()
        if (!fresh) return CLOSE_ACCESS_DENIED
        const auth: SocketAuthMessage = { type: 'auth', account: true, device: await socketProof(path) }
        return authedSocket(path, auth, relaySocketProtocols(fresh.ticket))
      }),
  }
}
