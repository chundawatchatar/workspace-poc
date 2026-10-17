import { API_PREFIX, type HostInfo } from '@orch/shared'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { localOrigin } from './lib/localOrigin'
import type { EventHub } from './modules/events/events.service'
import { createEventsSocket } from './modules/events/events.ws'
import { fsRoutes } from './modules/fs/fs.routes'
import { gitRoutes } from './modules/git/git.routes'
import type { LayoutRepository } from './modules/layout/layout.repository'
import { systemRoutes } from './modules/system/system.routes'
import type { SessionManager } from './modules/terminals/terminals.service'
import { createTerminalSocket } from './modules/terminals/terminals.ws'

export interface AppDeps {
  hub: EventHub
  layout: LayoutRepository
  sessions: SessionManager
  info: HostInfo
}

/** The host's HTTP and WebSocket routes. Each feature module is mounted here. */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono()

  // This server starts shells, so it only answers pages served from this machine.
  app.use('*', async (c, next) => {
    if (!localOrigin(c.req.header('origin'))) return c.text('forbidden', 403)
    await next()
  })
  app.use(`${API_PREFIX}/*`, cors({ origin: (origin) => (localOrigin(origin) ? origin : null) }))

  // Every module's paths are full paths from `routes` in @orch/shared, so they all mount at the root.
  app.route('/', systemRoutes)
  app.route('/', fsRoutes)
  app.route('/', gitRoutes)
  app.route('/', createEventsSocket(deps))
  app.route('/', createTerminalSocket(deps.sessions))

  return app
}
