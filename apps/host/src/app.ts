import { API_PREFIX, routes } from '@orch/shared'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { localOrigin } from './lib/localOrigin'
import { tunnelPrincipal } from './lib/principal'
import { createSocketRouter, type SocketRouter, socketEntry } from './lib/socketRouter'
import { type AccessDeps, createAccessRoutes } from './modules/access/access.routes'
import { createEventsSocket, type EventsSocketDeps, eventsSocketHandler } from './modules/events/events.ws'
import { fsRoutes } from './modules/fs/fs.routes'
import { gitRoutes } from './modules/git/git.routes'
import { createRemoteAccessRoutes, type RemoteAccessDeps } from './modules/remote-access/remote-access.routes'
import { createSystemRoutes, type SystemDeps } from './modules/system/system.routes'
import { createTerminalSocket, terminalSocketHandler } from './modules/terminals/terminals.ws'

/** Everything the modules need, built once in `index.ts`. Add another module's deps with `&`. */
export type AppDeps = EventsSocketDeps & SystemDeps & AccessDeps & RemoteAccessDeps

/** The host's routes: `app` serves HTTP and local sockets, and `sockets` opens the same sockets for the tunnel. */
export interface HostApp {
  app: Hono
  sockets: SocketRouter
}

/** Builds the host's HTTP and WebSocket routes. Each feature module is mounted here. */
export function createApp(deps: AppDeps): HostApp {
  const app = new Hono()
  const events = eventsSocketHandler(deps)
  const terminal = terminalSocketHandler(deps.sessions)

  // This server starts shells, so it only answers pages served from this machine. A request the
  // tunnel authorized carries its access key in a header, never a cookie, so the key stands in for
  // the origin check: a foreign page cannot ride on a browser's ambient credentials.
  app.use('*', async (c, next) => {
    if (!tunnelPrincipal(c.env) && !localOrigin(c.req.header('origin'))) return c.text('forbidden', 403)
    await next()
  })
  app.use(`${API_PREFIX}/*`, cors({ origin: (origin) => (localOrigin(origin) ? origin : null) }))

  // Every module's paths are full paths from `routes` in @orch/shared, so they all mount at the root.
  app.route('/', createSystemRoutes(deps))
  app.route('/', fsRoutes)
  app.route('/', gitRoutes)
  app.route('/', createAccessRoutes(deps))
  app.route('/', createRemoteAccessRoutes(deps))
  app.route('/', createEventsSocket(events))
  app.route('/', createTerminalSocket(terminal))

  // A socket served here is also listed here, so it works through the tunnel too.
  const sockets = createSocketRouter([
    socketEntry(routes.sockets.events, events),
    socketEntry(routes.sockets.terminal, terminal),
  ])
  return { app, sockets }
}
