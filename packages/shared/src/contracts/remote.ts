import { z } from 'zod'
import { API_PREFIX, WS_PREFIX } from './contract'

// How a browser reaches a machine through the cloud server. The server forwards
// `/m/<machineId>/api/*` and `/m/<machineId>/ws/*` to the machine, and the
// machine checks the access key, or a relay ticket the server signed for the
// account. Neither ever goes in a URL, so they stay out of server logs, proxies
// and browser history.

/** The request header that carries a machine's access key on HTTP requests. */
export const ACCESS_KEY_HEADER = 'x-orch-access-key'

/**
 * The first text message on every remote socket, sent before anything else,
 * since browsers can't set socket headers. It carries the access key, or
 * `account: true` to be judged by the relay ticket the socket opened with.
 */
export const socketAuthMessage = z.union([
  z.object({ type: z.literal('auth'), key: z.string().min(1) }),
  z.object({ type: z.literal('auth'), account: z.literal(true) }),
])

export type SocketAuthMessage = z.infer<typeof socketAuthMessage>

/** The server path every route of a machine sits under: `/m/<machineId>`. */
export function machinePathPrefix(machineId: string): string {
  return `/m/${encodeURIComponent(machineId)}`
}

/** The server route pattern for a machine's HTTP endpoints, `/m/:machineId/api/*`, in Hono syntax. */
export const MACHINE_API_ROUTE = `/m/:machineId${API_PREFIX}/*`

/** The server route pattern for a machine's WebSockets, `/m/:machineId/ws/*`, in Hono syntax. */
export const MACHINE_WS_ROUTE = `/m/:machineId${WS_PREFIX}/*`

/** The close code a browser socket gets when its machine has no live tunnel, or the tunnel drops. */
export const CLOSE_MACHINE_OFFLINE = 4502

/** The close code a browser socket gets when its access key is missing, wrong, late or rotated. */
export const CLOSE_ACCESS_DENIED = 4401

/** The close code a browser socket gets when the server refuses it for a rate limit. */
export const CLOSE_RATE_LIMITED = 4429

/** What a connect link carries: the machine to open and the key to open it with. */
export interface ConnectTarget {
  machineId: string
  key: string
}

/** The URL fragment of a connect link, such as `#machine=<id>&key=<key>`. Fragments never reach the server. */
export function formatConnectFragment({ machineId, key }: ConnectTarget): string {
  return `#${new URLSearchParams({ machine: machineId, key })}`
}

/** Reads a connect link's fragment, with or without the leading `#`; null means a field is missing or empty. */
export function parseConnectFragment(hash: string): ConnectTarget | null {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash)
  const machineId = params.get('machine')
  const key = params.get('key')
  if (!machineId || !key) return null
  return { machineId, key }
}
