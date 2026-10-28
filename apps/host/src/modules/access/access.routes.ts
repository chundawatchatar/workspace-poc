import { routes } from '@orch/shared'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { createRouter } from '../../lib/createRouter'
import { tunnelPrincipal } from '../../lib/principal'
import { type RemoteAccess, rotateAccess } from './access.service'

/** What the access routes need from the host. */
export interface AccessDeps {
  /** What rotating the key needs right now. Null means no server address is known, so there is nothing to rotate. */
  access?: () => RemoteAccess | null
}

/** Serves `routes.access`, to local callers only: a request that came through the tunnel gets 403. */
export function createAccessRoutes({ access }: AccessDeps) {
  return new Hono()
    .use(routes.access.rotate.path, async (c, next) => {
      if (tunnelPrincipal(c.env)) return c.text('forbidden', 403)
      await next()
    })
    .route(
      '/',
      createRouter(routes.access, {
        rotate: async () => {
          const current = access?.()
          if (!current) {
            throw new HTTPException(409, {
              message: 'remote access is off: no server address is set, in the Remote access setting or SERVER_URL',
            })
          }
          return rotateAccess(current)
        },
      }),
    )
}
