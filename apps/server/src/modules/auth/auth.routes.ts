import { Hono } from 'hono'
import type { ApiModule } from '../../app'
import type { ClientIpOf } from '../../lib/clientIp'
import { type Auth, CLIENT_IP_HEADER } from './auth.service'

/** What the auth routes need: the Better Auth instance and the reader for the client IP. */
export interface AuthRoutesDeps {
  auth: Pick<Auth, 'handler'>
  clientIp: ClientIpOf
}

/**
 * Builds the module that hands every `GET` and `POST` under `/api/auth/*` to
 * Better Auth, which does its own origin and CSRF checks. These paths are
 * never in `serverRoutes`.
 */
export function createAuthModule({ auth, clientIp }: AuthRoutesDeps): ApiModule {
  return () => {
    const router = new Hono()
    router.on(['GET', 'POST'], '/api/auth/*', (c) => {
      // Better Auth keys its rate limits on this header. Setting it here replaces whatever the client sent, so a
      // spoofed `X-Forwarded-For` neither dodges the limit nor moves it onto someone else.
      const headers = new Headers(c.req.raw.headers)
      headers.set(CLIENT_IP_HEADER, clientIp(c))
      return auth.handler(new Request(c.req.raw, { headers }))
    })
    return router
  }
}
