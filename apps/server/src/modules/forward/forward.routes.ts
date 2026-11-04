import { MACHINE_API_ROUTE } from '@orch/shared'
import { Hono } from 'hono'
import { type LimitsDeps, limitBrowserRequests } from '../limits/limits.middleware'
import type { RelayAccount } from '../machines/relay-account.service'
import type { HttpForwarder } from './forward.service'

/** What the forward routes need from the server. */
export interface ForwardRoutesDeps extends LimitsDeps {
  forwarder: HttpForwarder
  /** Says which account sent a relayed request or socket. Null or missing means accounts are off, and none is sent. */
  relayAccount?: RelayAccount | null
}

/**
 * Serves `MACHINE_API_ROUTE` for every method by relaying the request to the
 * machine, once the rate limits admit it, with the account `relayAccount`
 * answers. The origin check runs before this, for all of `/m/*`, in `app.ts`.
 */
export function createForwardRoutes(deps: ForwardRoutesDeps) {
  const { forwarder, clientIp, relayAccount } = deps
  return new Hono().all(MACHINE_API_ROUTE, limitBrowserRequests(deps), async (c) => {
    // Hono hands out the `machineId` param already URI-decoded.
    const machineId = c.req.param('machineId')
    const accountId = relayAccount ? await relayAccount(c, machineId) : null
    return forwarder.forward(machineId, c.req.raw, clientIp(c), accountId)
  })
}
