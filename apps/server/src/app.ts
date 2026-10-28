import { Hono } from 'hono'
import { createForwardRoutes, type ForwardRoutesDeps } from './modules/forward/forward.routes'
import { createTunnelSocket, type TunnelSocketDeps } from './modules/tunnel/tunnel.ws'

/** Everything the server's modules need, built once in `index.ts`. Add another module's deps with `&`. */
export type AppDeps = Omit<TunnelSocketDeps, 'onFrame' | 'onClose'> & ForwardRoutesDeps

/** The server's routes. Each feature module is mounted here. */
export function createApp(deps: AppDeps): Hono {
  const { forwarder } = deps
  const app = new Hono()
  app.route(
    '/',
    createTunnelSocket({
      ...deps,
      onFrame: (conn, frame) => forwarder.handleFrame(conn, frame),
      onClose: (conn) => forwarder.connectionClosed(conn),
    }),
  )
  app.route('/', createForwardRoutes(deps))
  return app
}
