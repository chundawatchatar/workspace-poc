import { getConnInfo } from '@hono/bun'
import type { Context } from 'hono'

/** Reads the client IP of a request. */
export type ClientIpOf = (c: Context) => string

/** The key requests share when neither the socket nor the proxy gives an address. */
const UNKNOWN_IP = 'unknown'

/**
 * The client IP the last proxy saw: the rightmost entry of an
 * `X-Forwarded-For` header. Null means there is no non-empty entry.
 */
export function forwardedFor(header: string | undefined): string | null {
  const entries = (header ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  return entries.at(-1) ?? null
}

/**
 * Builds the reader for the client IP. By default it is the socket address Bun
 * reports, which needs the Bun server as the request's env. With `trustProxy`
 * it is the rightmost `X-Forwarded-For` entry, falling back to the socket
 * address. Only turn that on behind a proxy that sets the header, since a
 * browser can send any value.
 */
export function clientIpReader({ trustProxy = false }: { trustProxy?: boolean } = {}): ClientIpOf {
  return (c) => {
    const forwarded = trustProxy ? forwardedFor(c.req.header('x-forwarded-for')) : null
    if (forwarded) return forwarded
    try {
      return getConnInfo(c).remote.address ?? UNKNOWN_IP
    } catch {
      // `app.fetch` called without a Bun server as its env, as in some tests.
      return UNKNOWN_IP
    }
  }
}
