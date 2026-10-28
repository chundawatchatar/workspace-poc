/**
 * How the page reaches a host. Every request and socket the page makes goes through one of these, so the same page
 * can talk to the local host or, later, to a remote machine.
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
