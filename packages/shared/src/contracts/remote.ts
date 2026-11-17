import { z } from 'zod'
import { API_PREFIX, WS_PREFIX } from './contract'

// How a browser reaches a machine through the cloud server. The server forwards
// `/m/<machineId>/api/*` and `/m/<machineId>/ws/*` to the machine, and the
// machine checks the relay ticket the server signed for the account, together
// with a proof from a device approved on the machine. Neither ever goes in a
// URL, so they stay out of server logs, proxies and browser history.

/**
 * The first text message on every remote socket, sent before anything else,
 * since browsers can't set socket headers. `account: true` asks to be judged
 * by the relay ticket the socket opened with, and `device` is a fresh device
 * proof for the socket (`'WS'` and its path).
 */
export const socketAuthMessage = z.object({
  type: z.literal('auth'),
  account: z.literal(true),
  device: z.string().min(1).max(4096),
})

export type SocketAuthMessage = z.infer<typeof socketAuthMessage>

/** The server path every route of a machine sits under: `/m/<machineId>`. */
export function machinePathPrefix(machineId: string): string {
  return `/m/${encodeURIComponent(machineId)}`
}

/** The server route pattern for a machine's HTTP endpoints, `/m/:machineId/api/*`, in Hono syntax. */
export const MACHINE_API_ROUTE = `/m/:machineId${API_PREFIX}/*`

/** The server route pattern for a machine's WebSockets, `/m/:machineId/ws/*`, in Hono syntax. */
export const MACHINE_WS_ROUTE = `/m/:machineId${WS_PREFIX}/*`

/**
 * The server route a browser posts sealed HTTP envelopes to, `/m/:machineId/e2e`, in Hono syntax. It is the
 * server's envelope path, not a machine route, so it is not in the `routes` registry.
 */
export const MACHINE_SEALED_ROUTE = '/m/:machineId/e2e'

/** The path of a machine's sealed route, `/m/<machineId>/e2e`. */
export function machineSealedPath(machineId: string): string {
  return `${machinePathPrefix(machineId)}/e2e`
}

/**
 * The server route a browser opens sealed sockets on, `/m/:machineId/e2e/ws`, in Hono syntax. Like
 * `MACHINE_SEALED_ROUTE`, it is the server's envelope path, not a machine route.
 */
export const MACHINE_SEALED_SOCKET_ROUTE = '/m/:machineId/e2e/ws'

/** The path of a machine's sealed socket route, `/m/<machineId>/e2e/ws`. */
export function machineSealedSocketPath(machineId: string): string {
  return `${machineSealedPath(machineId)}/ws`
}

/**
 * The close code a sealed socket gets when the machine doesn't have the end-to-end session it names (unknown,
 * expired or closed). The browser drops its session, so the page's reconnect opens a new one.
 */
export const CLOSE_E2E_SESSION_UNKNOWN = 4409

/** The close code a browser socket gets when its machine has no live tunnel, or the tunnel drops. */
export const CLOSE_MACHINE_OFFLINE = 4502

/** The close code a browser socket gets when its credentials are missing, refused or late, or its access was revoked. */
export const CLOSE_ACCESS_DENIED = 4401

/**
 * The close code a browser socket opened with a relay ticket gets when its
 * account ended a session on the server. It is not a denial: a browser still
 * signed in reconnects with a fresh ticket, and a signed-out one gets none.
 */
export const CLOSE_SESSION_ENDED = 4410

/** The close code a browser socket gets when the server refuses it for a rate limit. */
export const CLOSE_RATE_LIMITED = 4429

/**
 * What a connect link carries: the machine to open, the key to open it with, and the machine's `fingerprint`
 * (`machineFingerprint(machineId)`), which the host printed, so the browser can trust the id without the server.
 */
export interface ConnectTarget {
  machineId: string
  key: string
  fingerprint: string
}

/**
 * The URL fragment of a connect link, such as `#machine=<id>&key=<key>&fp=<fingerprint>`. Fragments never reach the
 * server.
 */
export function formatConnectFragment({ machineId, key, fingerprint }: ConnectTarget): string {
  return `#${new URLSearchParams({ machine: machineId, key, fp: fingerprint })}`
}

/** Reads a connect link's fragment, with or without the leading `#`; null means a field is missing or empty. */
export function parseConnectFragment(hash: string): ConnectTarget | null {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash)
  const machineId = params.get('machine')
  const key = params.get('key')
  const fingerprint = params.get('fp')
  if (!machineId || !key || !fingerprint) return null
  return { machineId, key, fingerprint }
}
