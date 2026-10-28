import { ACCESS_KEY_HEADER, machinePathPrefix, type SocketAuthMessage } from '@orch/shared'

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

export interface RemoteTransportOptions {
  /** The cloud server, such as `https://example.com`. Only `http:` and `https:` are accepted. */
  serverUrl: string
  machineId: string
  /** The machine's access key. It goes in a header or the first socket message, never in a URL. */
  accessKey: string
}

/**
 * A transport that reaches a machine through the cloud server, under `machinePathPrefix(machineId)`. Requests carry
 * the key in `ACCESS_KEY_HEADER`. Sockets send `socketAuthMessage` as their first message, ahead of anything the
 * page sends from its own `onopen`.
 */
export function createRemoteTransport({ serverUrl, machineId, accessKey }: RemoteTransportOptions): HostTransport {
  const server = new URL(serverUrl)
  if (server.protocol !== 'http:' && server.protocol !== 'https:') {
    throw new Error(`The server URL must use http: or https:, not ${server.protocol}`)
  }
  const http = `${server.origin}${server.pathname.replace(/\/$/, '')}${machinePathPrefix(machineId)}`
  const ws = http.replace(/^http/, 'ws')
  const auth = JSON.stringify({ type: 'auth', key: accessKey } satisfies SocketAuthMessage)
  return {
    request: (path, init) => {
      const headers = new Headers(init.headers)
      headers.set(ACCESS_KEY_HEADER, accessKey)
      return fetch(`${http}${path}`, { ...init, headers })
    },
    openSocket: (path) => {
      const socket = new WebSocket(`${ws}${path}`)
      // Listeners run in the order they were added, and the page can only set `onopen` after this returns, so the
      // auth message always goes out first.
      socket.addEventListener('open', () => socket.send(auth), { once: true })
      return socket
    },
  }
}
