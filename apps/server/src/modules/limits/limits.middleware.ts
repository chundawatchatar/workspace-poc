import type { MiddlewareHandler } from 'hono'
import type { ClientIpOf } from '../../lib/clientIp'
import type { ConnectionLimiter } from './limits.service'

/** What the limit middlewares need from the server. */
export interface LimitsDeps {
  limiter: ConnectionLimiter
  clientIp: ClientIpOf
}

/** The answer to an HTTP request or upgrade refused by a rate limit. */
export function tooManyRequests(retryAfterSeconds: number): Response {
  return new Response('Too Many Requests', { status: 429, headers: { 'Retry-After': String(retryAfterSeconds) } })
}

/** Answers 429 to a browser request whose IP or machine is out of tokens, before it goes any further. */
export function limitBrowserRequests({ limiter, clientIp }: LimitsDeps): MiddlewareHandler {
  return async (c, next) => {
    const admission = limiter.admitBrowser(clientIp(c), c.req.param('machineId') ?? '')
    if (!admission.ok) return tooManyRequests(admission.retryAfterSeconds)
    await next()
  }
}

/** Answers 429 to a tunnel upgrade whose IP is out of tunnel tokens. */
export function limitTunnelUpgrades({ limiter, clientIp }: LimitsDeps): MiddlewareHandler {
  return async (c, next) => {
    const admission = limiter.admitTunnel(clientIp(c))
    if (!admission.ok) return tooManyRequests(admission.retryAfterSeconds)
    await next()
  }
}
