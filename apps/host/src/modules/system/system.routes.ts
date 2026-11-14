import { routes } from '@orch/shared'
import type { SessionManager } from '@orch/terminal'
import { HTTPException } from 'hono/http-exception'
import { createRouter } from '../../lib/createRouter'
import { type DaemonState, daemonStatus } from './system.service'

/** What the system routes need from the host. */
export interface SystemDeps {
  sessions: SessionManager
  /** What the host last heard from the terminal daemon, and the command that stops it. */
  daemon: () => DaemonState
  /** The machine key's public half, read from an existing key and never created. Null means none exists yet. */
  machinePublicKey: () => string | null
}

/** Serves `routes.system`. */
export function createSystemRoutes({ sessions, daemon, machinePublicKey }: SystemDeps) {
  return createRouter(routes.system, {
    health: async () => ({ ok: true }),
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
  })
}
