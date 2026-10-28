import { MACHINE_API_ROUTE } from '@orch/shared'
import { Hono } from 'hono'
import type { HttpForwarder } from './forward.service'

/** What the forward routes need from the server. */
export interface ForwardRoutesDeps {
  forwarder: HttpForwarder
}

/** Serves `MACHINE_API_ROUTE` for every method by relaying the request to the machine. */
export function createForwardRoutes({ forwarder }: ForwardRoutesDeps) {
  // Hono hands out the `machineId` param already URI-decoded.
  return new Hono().all(MACHINE_API_ROUTE, (c) => forwarder.forward(c.req.param('machineId'), c.req.raw))
}
