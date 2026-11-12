import { E2eError, routes } from '@orch/shared'
import { HTTPException } from 'hono/http-exception'
import { createRouter } from '../../lib/createRouter'
import { tunnelPrincipal } from '../../lib/principal'
import { E2eDeviceMismatch, E2eSessionClosed, type E2eSessions } from './e2e.service'

/** What the end-to-end routes need from the host. */
export interface E2eDeps {
  e2eSessions: Pick<E2eSessions, 'open'>
}

/**
 * Serves `routes.e2e`, through the tunnel only: a local caller gets 403, since
 * it has no device to bind a session to. The tunnel has already checked the
 * key or ticket and that the device is approved. The error messages are fixed
 * and never name a key, a signature or a session id.
 */
export function createE2eRoutes({ e2eSessions }: E2eDeps) {
  return createRouter(routes.e2e, {
    open: async (hello, c) => {
      const principal = tunnelPrincipal(c.env)
      if (!principal) throw new HTTPException(403, { message: 'end-to-end sessions open only through the tunnel' })
      try {
        return await e2eSessions.open(principal, hello)
      } catch (error) {
        if (error instanceof E2eError) throw new HTTPException(400, { message: 'the hello did not verify' })
        if (error instanceof E2eDeviceMismatch || error instanceof E2eSessionClosed) {
          throw new HTTPException(403, { message: error.message })
        }
        throw error
      }
    },
  })
}
