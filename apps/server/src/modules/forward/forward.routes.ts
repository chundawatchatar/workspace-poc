import { MACHINE_API_ROUTE } from '@orch/shared'
import { Hono } from 'hono'
import { type LimitsDeps, limitBrowserRequests } from '../limits/limits.middleware'
import type { HttpForwarder } from './forward.service'

/** What the forward routes need from the server. */
export interface ForwardRoutesDeps extends LimitsDeps {
  forwarder: HttpForwarder
}

/**
 * Serves `MACHINE_API_ROUTE` for every method by relaying the request to the
 * machine, once the rate limits admit it. The origin check runs before this,
 * for all of `/m/*`, in `app.ts`.
 */
export function createForwardRoutes(deps: ForwardRoutesDeps) {
  const { forwarder, clientIp } = deps
  // Hono hands out the `machineId` param already URI-decoded.
  return new Hono().all(MACHINE_API_ROUTE, limitBrowserRequests(deps), (c) =>
    forwarder.forward(c.req.param('machineId'), c.req.raw, clientIp(c)),
  )
}
