import { routes } from '@orch/shared'
import type { SessionManager } from '@orch/terminal'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { createRouter } from '../../lib/createRouter'
import { tunnelPrincipal } from '../../lib/principal'
import { type DaemonState, daemonStatus } from './system.service'

/** What the system routes need from the host. */
export interface SystemDeps {
  sessions: SessionManager
  /** What the host last heard from the terminal daemon, and the command that stops it. */
  daemon: () => DaemonState
  /** The machine key's public half, read from an existing key and never created. Null means none exists yet. */
  machinePublicKey: () => string | null
  /** The random id this host process picked at start. */
  instanceId: string
}

/**
 * Serves `routes.system`. The instance id is what `corch` checks before it signals a process, so a request that came
 * through the tunnel gets 403 for it, like `routes.remoteAccess`.
 */
export function createSystemRoutes({ sessions, daemon, machinePublicKey, instanceId }: SystemDeps) {
  const router = new Hono()
  router.use(routes.system.instance.path, async (c, next) => {
    if (tunnelPrincipal(c.env)) return c.text('forbidden', 403)
    await next()
  })
  return router.route(
    '/',
    createRouter(routes.system, {
      health: async () => ({ ok: true }),
      instance: async () => ({ instanceId }),
      daemon: async () =>
        daemonStatus({
          ...daemon(),
          liveTerminals: sessions.list().filter((session) => session.info().alive).length,
          now: Date.now(),
        }),
      machineKey: async () => {
        const publicKey = machinePublicKey()
        if (!publicKey) throw new HTTPException(404, { message: 'this machine has no machine key yet' })
        return { publicKey }
      },
    }),
  )
}
