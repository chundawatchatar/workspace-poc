import { routes } from '@orch/shared'
import type { SessionManager } from '@orch/terminal'
import { createRouter } from '../../lib/createRouter'
import { daemonStatus } from './system.service'

/** What the system routes need from the host. */
export interface SystemDeps {
  sessions: SessionManager
  /** When the terminal daemon started, in epoch milliseconds, or null when no status has said. */
  daemonStartedAt: () => number | null
}

/** Serves `routes.system`. */
export function createSystemRoutes({ sessions, daemonStartedAt }: SystemDeps) {
  return createRouter(routes.system, {
    health: async () => ({ ok: true }),
    daemon: async () =>
      daemonStatus({
        startedAt: daemonStartedAt(),
        liveTerminals: sessions.list().filter((session) => session.info().alive).length,
        now: Date.now(),
      }),
  })
}
