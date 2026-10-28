import type { Socket } from '@orch/shared'
import { HOST_ORIGIN, localOrigin } from './localOrigin'
import type { SocketConn, SocketHandler, SocketSession } from './socket'

/** Why a socket was not opened, as the close code and reason to answer with. */
export interface SocketRefusal {
  code: number
  reason: string
}

/** One socket from `routes.sockets` and the handler that serves it. */
export interface SocketEntry {
  socket: Socket
  // The handler's input type is erased here; `socketEntry` checks it against the socket's schema.
  handler: SocketHandler<Socket>
}

/** Pairs a socket with its handler, checking that the handler takes the socket's input. */
export function socketEntry<S extends Socket>(socket: S, handler: SocketHandler<S>): SocketEntry {
  return { socket, handler: handler as SocketHandler<Socket> }
}

/** Opens sockets by path, for connections that do not come through Hono. */
export interface SocketRouter {
  /** Opens the socket at `path` (with its query string) on `conn`, or says why not. */
  open(path: string, headers: [string, string][], conn: SocketConn): SocketSession | SocketRefusal
}

/** True when `open` refused the socket. */
export function isRefusal(result: SocketSession | SocketRefusal): result is SocketRefusal {
  return 'code' in result
}

/** Close code for a socket the host will not open. */
const CLOSE_POLICY = 1008

/**
 * Routes paths to `entries` with the same rules as the host's Hono routes: the
 * URL's pathname must match one socket's path segment for segment, `:param`
 * segments are percent-decoded once, the query is read as `c.req.query()`
 * reads it, the input must pass the socket's schema, and an `origin` header
 * must pass `localOrigin`.
 */
export function createSocketRouter(entries: SocketEntry[]): SocketRouter {
  const routes = entries.map((entry) => ({ ...entry, segments: entry.socket.path.split('/') }))
  return {
    open(path, headers, conn) {
      let url: URL
      try {
        // Joined as strings, so the path is never resolved against the origin as a relative URL.
        url = new URL(HOST_ORIGIN + path)
      } catch {
        return { code: CLOSE_POLICY, reason: 'bad url' }
      }
      // URL parsing resolves `..` and `%2e%2e`, so the match runs on what it made of the path.
      const segments = url.pathname.split('/')
      let matched: { entry: SocketEntry; params: Record<string, string> } | null = null
      for (const route of routes) {
        const params = matchSegments(route.segments, segments)
        if (params) {
          matched = { entry: route, params }
          break
        }
      }
      if (!matched) return { code: CLOSE_POLICY, reason: 'not found' }

      const origin = headers.find(([name]) => name.toLowerCase() === 'origin')?.[1]
      if (!localOrigin(origin)) return { code: CLOSE_POLICY, reason: 'forbidden' }

      const input = matched.entry.socket.input.safeParse({ ...readQuery(url), ...matched.params })
      if (!input.success) return { code: CLOSE_POLICY, reason: 'bad input' }
      return matched.entry.handler(input.data, conn)
    },
  }
}

/** The params of `actual` when it matches `pattern` segment for segment, or null. */
function matchSegments(pattern: string[], actual: string[]): Record<string, string> | null {
  if (pattern.length !== actual.length) return null
  const params: Record<string, string> = Object.create(null)
  for (const [i, part] of pattern.entries()) {
    const value = actual[i] ?? ''
    if (!part.startsWith(':')) {
      if (value !== part) return null
      continue
    }
    if (!value) return null
    try {
      params[part.slice(1)] = decodeURIComponent(value)
    } catch {
      return null
    }
  }
  return params
}

/** The query fields, the first value of each name winning, as Hono's `c.req.query()` has them. */
function readQuery(url: URL): Record<string, string> {
  const query: Record<string, string> = Object.create(null)
  for (const [name, value] of url.searchParams) {
    if (name && !Object.hasOwn(query, name)) query[name] = value
  }
  return query
}
