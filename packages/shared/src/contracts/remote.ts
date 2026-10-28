import { z } from 'zod'

// How a browser reaches a machine through the cloud server. The server forwards
// `/m/<machineId>/api/*` and `/m/<machineId>/ws/*` to the machine, and the
// machine checks the access key. The key never goes in a URL, so it stays out of
// server logs, proxies and browser history.

/** The request header that carries a machine's access key on HTTP requests. */
export const ACCESS_KEY_HEADER = 'x-orch-access-key'

/** The first text message on every remote socket, sent before anything else. Browsers can't set socket headers. */
export const socketAuthMessage = z.object({ type: z.literal('auth'), key: z.string().min(1) })

export type SocketAuthMessage = z.infer<typeof socketAuthMessage>

/** The server path every route of a machine sits under: `/m/<machineId>`. */
export function machinePathPrefix(machineId: string): string {
  return `/m/${encodeURIComponent(machineId)}`
}

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
