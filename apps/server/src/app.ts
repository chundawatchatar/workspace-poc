import { Hono } from 'hono'
import { createTunnelSocket, type TunnelSocketDeps } from './modules/tunnel/tunnel.ws'

/** Everything the server's modules need, built once in `index.ts`. Add another module's deps with `&`. */
export type AppDeps = TunnelSocketDeps

/** The server's routes. Each feature module is mounted here. */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono()
  app.route('/', createTunnelSocket(deps))
  return app
}
