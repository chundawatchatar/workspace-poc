import { API_PREFIX, routes } from '@orch/shared'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { localHost } from './lib/localHost'
import { localOrigin } from './lib/localOrigin'
import { tunnelPrincipal } from './lib/principal'
import { createSocketRouter, type SocketRouter, socketEntry } from './lib/socketRouter'
import { createE2eRoutes, type E2eDeps } from './modules/e2e/e2e.routes'
import { createEventsSocket, type EventsSocketDeps, eventsSocketHandler } from './modules/events/events.ws'
import { fsRoutes } from './modules/fs/fs.routes'
import { gitRoutes } from './modules/git/git.routes'
import { createRemoteAccessRoutes, type RemoteAccessDeps } from './modules/remote-access/remote-access.routes'
import { createSystemRoutes, type SystemDeps } from './modules/system/system.routes'
import { createTerminalSocket, terminalSocketHandler } from './modules/terminals/terminals.ws'
import { createUiRoutes, type UiDeps } from './modules/ui/ui.routes'

/** Everything the modules need, built once in `index.ts`. Add another module's deps with `&`. */
export type AppDeps = EventsSocketDeps & SystemDeps & RemoteAccessDeps & E2eDeps & UiDeps

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

  // A page on another site can rename itself to this machine (DNS rebinding: `evil.example` later
  // resolves to 127.0.0.1) and then make same-origin requests with no `Origin`, which the origin
  // check lets through. Its requests still say `Host: evil.example:<port>`, so every local request
  // and socket upgrade must name a loopback address and the port this server listens on. The port
  // comes from Bun's server, which Bun passes as the env; with no server there is nothing to match,
  // so the request is refused. Tunneled requests are exempt: the tunnel already authorized them,
  // their `Host` was dropped by the relay, and a symbol env, never a header, marks them.
  app.use('*', async (c, next) => {
    if (!tunnelPrincipal(c.env) && !localHost(c.req.header('host'), listeningPort(c.env))) {
      return c.text('forbidden', 403)
    }
    await next()
  })
  // This server starts shells, so it only answers pages served from this machine. A request the
  // tunnel authorized carries its relay ticket in a header, never a cookie, so the ticket stands in
  // for the origin check: a foreign page cannot ride on a browser's ambient credentials.
  app.use('*', async (c, next) => {
    if (!tunnelPrincipal(c.env) && !localOrigin(c.req.header('origin'))) return c.text('forbidden', 403)
    await next()
  })
  app.use(`${API_PREFIX}/*`, cors({ origin: (origin) => (localOrigin(origin) ? origin : null) }))

  // Every module's paths are full paths from `routes` in @orch/shared, so they all mount at the root.
  app.route('/', createSystemRoutes(deps))
  app.route('/', fsRoutes)
  app.route('/', gitRoutes)
  app.route('/', createRemoteAccessRoutes(deps))
  app.route('/', createE2eRoutes(deps))
  app.route('/', createEventsSocket(events))
  app.route('/', createTerminalSocket(terminal))
  // Last, behind the origin check above, so no API or socket path is ever shadowed by the page.
  if (deps.ui) app.route('/', createUiRoutes(deps.ui))

  // A socket served here is also listed here, so it works through the tunnel too.
  const sockets = createSocketRouter([
    socketEntry(routes.sockets.events, events),
    socketEntry(routes.sockets.terminal, terminal),
  ])
  return { app, sockets }
}

/** The port of the Bun server a local request came through, or 0 when its env is not a server. */
function listeningPort(env: unknown): number {
  if (typeof env !== 'object' || env === null) return 0
  const port = (env as { port?: unknown }).port
  return typeof port === 'number' ? port : 0
}
