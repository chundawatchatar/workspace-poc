import { routes } from '@orch/shared'
import type { SessionManager } from '@orch/terminal'
import { HTTPException } from 'hono/http-exception'
import { createRouter } from '../../lib/createRouter'
import { daemonStatus } from './system.service'

/** What the system routes need from the host. */
export interface SystemDeps {
  sessions: SessionManager
  /** When the terminal daemon started, in epoch milliseconds, or null when no status has said. */
  daemonStartedAt: () => number | null
  /** The machine key's public half, read from an existing key and never created. Null means none exists yet. */
  machinePublicKey: () => string | null
}

/** Serves `routes.system`. */
export function createSystemRoutes({ sessions, daemonStartedAt, machinePublicKey }: SystemDeps) {
  return createRouter(routes.system, {
    health: async () => ({ ok: true }),
    daemon: async () =>
      daemonStatus({
        startedAt: daemonStartedAt(),
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
