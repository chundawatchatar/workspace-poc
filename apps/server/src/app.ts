import { Hono } from 'hono'
import { type BridgeSocketDeps, createBridgeSocket } from './modules/bridge/bridge.ws'
import { createForwardRoutes, type ForwardRoutesDeps } from './modules/forward/forward.routes'
import { createTunnelSocket, type TunnelSocketDeps } from './modules/tunnel/tunnel.ws'

/** Everything the server's modules need, built once in `index.ts`. Add another module's deps with `&`. */
export type AppDeps = Omit<TunnelSocketDeps, 'onFrame' | 'onClose'> & ForwardRoutesDeps & BridgeSocketDeps

/** The server's routes. Each feature module is mounted here. */
export function createApp(deps: AppDeps): Hono {
  const { forwarder, bridge } = deps
  const app = new Hono()
  app.route(
    '/',
    createTunnelSocket({
      ...deps,
      onFrame: (conn, frame) => {
        if (frame.type === 'ws.data' || frame.type === 'ws.close' || frame.type === 'ws.ack') {
          bridge.handleFrame(conn, frame)
        } else {
          forwarder.handleFrame(conn, frame)
        }
      },
      onClose: (conn) => {
        forwarder.connectionClosed(conn)
        bridge.connectionClosed(conn)
      },
    }),
  )
  app.route('/', createForwardRoutes(deps))
  app.route('/', createBridgeSocket(deps))
  return app
}
