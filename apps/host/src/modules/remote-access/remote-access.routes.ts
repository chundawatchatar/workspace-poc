import { routes } from '@orch/shared'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { createRouter } from '../../lib/createRouter'
import { tunnelPrincipal } from '../../lib/principal'
import { InvalidRemoteAccessSetting, LinkError, type RemoteAccessService } from './remote-access.service'

/** What the remote access routes need from the host. */
export interface RemoteAccessDeps {
  remoteAccess: Pick<RemoteAccessService, 'status' | 'update' | 'previewLink' | 'link' | 'unlink'>
}

/**
 * Serves `routes.remoteAccess`, to local callers only: a request that came
 * through the tunnel gets 403, so a remote page can never move or close it.
 */
export function createRemoteAccessRoutes({ remoteAccess }: RemoteAccessDeps) {
  const router = new Hono()
  for (const endpoint of Object.values(routes.remoteAccess)) {
    router.use(endpoint.path, async (c, next) => {
      if (tunnelPrincipal(c.env)) return c.text('forbidden', 403)
      await next()
    })
  }
  return router.route(
    '/',
    createRouter(routes.remoteAccess, {
      status: async () => remoteAccess.status(),
      update: async (input) => {
        try {
          return remoteAccess.update(input)
        } catch (error) {
          if (error instanceof InvalidRemoteAccessSetting) throw new HTTPException(400, { message: error.message })
          throw new HTTPException(500, {
            message: `remote access could not start: ${error instanceof Error ? error.message : 'unknown error'}`,
          })
        }
      },
      previewLink: (input) => linking(() => remoteAccess.previewLink(input)),
      link: (input) => linking(() => remoteAccess.link(input)),
      unlink: async () => remoteAccess.unlink(),
    }),
  )
}

/** Runs a link step, answering a `LinkError` with its status and message. */
async function linking<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step()
  } catch (error) {
    if (error instanceof LinkError) throw new HTTPException(error.status, { message: error.message })
    throw error
  }
}
