import { ACCESS_KEY_HEADER } from '@orch/shared'
import type { Context, MiddlewareHandler } from 'hono'

/** The headers every response from the server carries, relayed ones included. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
}

/**
 * The CSP for every response that is not the client's own page: relayed
 * machine responses and the build's other files. `sandbox` without
 * `allow-same-origin` gives a document opened from one an opaque origin, so
 * HTML a machine sends can never run as the server's origin and read the
 * access keys the client keeps in `localStorage`.
 */
export const SANDBOX_CSP = "sandbox; default-src 'none'; frame-ancestors 'none'"

// What a cross-origin page may send to a machine. The key header is the one
// that makes every machine request non-simple, so browsers preflight it.
const ALLOWED_METHODS = 'GET, HEAD, POST, PUT, PATCH, DELETE'
const ALLOWED_HEADERS = `${ACCESS_KEY_HEADER}, content-type`
const PREFLIGHT_MAX_AGE_SECONDS = '600'

/** Adds `SECURITY_HEADERS` to every response, after the handler has made it. */
export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next()
    setHeaders(c, Object.entries(SECURITY_HEADERS))
  }
}

/** How a request's `Origin` relates to the server. */
export type OriginVerdict = 'none' | 'same' | 'cross' | 'denied'

/** Reads `SERVER_ALLOWED_ORIGINS`: a comma-separated list of exact origins. */
export function parseAllowedOrigins(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
}

/**
 * Which origins may call the machine routes: the server's own (the `Origin`
 * host equals the `Host` header) and the exact origins listed. It reads only
 * the outer request's `Origin` and `Host`, never anything relayed.
 */
export class OriginPolicy {
  private readonly allowed: ReadonlySet<string>

  constructor(allowed: Iterable<string> = []) {
    this.allowed = new Set(allowed)
  }

  /** `none` when there is no `Origin`, which browsers leave off same-origin navigations and non-browser clients. */
  check(origin: string | undefined, host: string | undefined): OriginVerdict {
    if (origin === undefined) return 'none'
    if (this.allowed.has(origin)) return 'cross'
    try {
      return host !== undefined && new URL(origin).host === host ? 'same' : 'denied'
    } catch {
      // `Origin: null` from sandboxed frames and file pages, or a malformed value.
      return 'denied'
    }
  }
}

/**
 * The CORS handling for `/m/*`. A request from an origin outside the policy
 * gets 403 and goes no further. A preflight is answered here and never reaches
 * a machine. Other responses get `Access-Control-Allow-Origin` for an allowed
 * cross origin; the machine's own `Access-Control-*` headers are dropped by
 * the forwarder.
 */
export function machineCors(policy: OriginPolicy): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header('origin')
    const verdict = policy.check(origin, c.req.header('host'))
    const preflight = c.req.method === 'OPTIONS' && c.req.header('access-control-request-method') !== undefined
    if (verdict === 'denied' || (preflight && verdict === 'none')) return new Response('Forbidden', { status: 403 })
    if (preflight) {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': origin ?? '',
          Vary: 'Origin',
          'Access-Control-Allow-Methods': ALLOWED_METHODS,
          'Access-Control-Allow-Headers': ALLOWED_HEADERS,
          'Access-Control-Max-Age': PREFLIGHT_MAX_AGE_SECONDS,
        },
      })
    }
    await next()
    if (verdict === 'cross' && origin) {
      setHeaders(c, [['Access-Control-Allow-Origin', origin]])
      c.res.headers.append('Vary', 'Origin')
    }
  }
}

/** Sets headers on the finished response, copying it first when its headers are immutable. */
function setHeaders(c: Context, headers: [string, string][]): void {
  try {
    for (const [name, value] of headers) c.res.headers.set(name, value)
  } catch {
    c.res = new Response(c.res.body, c.res)
    for (const [name, value] of headers) c.res.headers.set(name, value)
  }
}
