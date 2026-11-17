import { routes } from '@orch/shared'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { createRouter } from '../../lib/createRouter'
import { tunnelPrincipal } from '../../lib/principal'
import { AmbiguousDevice, ConnectError, InvalidRemoteAccessSetting, UnknownDevice } from './remote-access.errors'
import type { RemoteAccessService } from './remote-access.service'

/** What the remote access routes need from the host. */
export interface RemoteAccessDeps {
  remoteAccess: Pick<
    RemoteAccessService,
    | 'status'
    | 'connect'
    | 'disconnect'
    | 'listDevices'
    | 'approveDevice'
    | 'removeDevice'
    | 'auditLog'
    | 'listSessions'
    | 'endSession'
  >
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
      connect: async (input) => {
        try {
          return await remoteAccess.connect(input)
        } catch (error) {
          if (error instanceof ConnectError) throw new HTTPException(error.status, { message: error.message })
          if (error instanceof InvalidRemoteAccessSetting) throw new HTTPException(400, { message: error.message })
          // The service's own errors never hold the key or the email, and nothing else sees them.
          throw new HTTPException(500, {
            message: `connecting failed: ${error instanceof Error ? error.message : 'unknown error'}`,
          })
        }
      },
      disconnect: async () => remoteAccess.disconnect(),
      devices: async () => remoteAccess.listDevices(),
      approveDevice: async ({ fingerprint }) => {
        try {
          return remoteAccess.approveDevice(fingerprint)
        } catch (error) {
          if (error instanceof UnknownDevice) throw new HTTPException(404, { message: error.message })
          if (error instanceof AmbiguousDevice) throw new HTTPException(409, { message: error.message })
          throw error
        }
      },
      removeDevice: async ({ id }) => remoteAccess.removeDevice(id),
      auditLog: async () => remoteAccess.auditLog(),
      sessions: async () => remoteAccess.listSessions(),
      endSession: async ({ id }) => remoteAccess.endSession(id),
    }),
  )
}
