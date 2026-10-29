import type { MachineFrame } from '@orch/shared'
import { Hono } from 'hono'
import { clientIpReader } from './lib/clientIp'
import { type ServerRouterOptions, serverErrorResponse } from './lib/createServerRouter'
import { machineCors, OriginPolicy, securityHeaders } from './lib/security'
import { type BridgeSocketDeps, createBridgeSocket } from './modules/bridge/bridge.ws'
import { createForwardRoutes, type ForwardRoutesDeps } from './modules/forward/forward.routes'
import type { LimitsDeps } from './modules/limits/limits.middleware'
import { createStaticRoutes, type StaticRoutesDeps } from './modules/static/static.routes'
import { createSystemRoutes } from './modules/system/system.routes'
import type { MachineConnection } from './modules/tunnel/tunnel.service'
import { createTunnelSocket, type TunnelSocketDeps } from './modules/tunnel/tunnel.ws'

/** Builds one module of the server API from the options every API router shares. */
export type ApiModule = (options: ServerRouterOptions) => Hono

/** Everything the server's modules need, built once in `index.ts`. Add another module's deps with `&`. */
export type AppDeps = Omit<TunnelSocketDeps, 'onFrame' | 'onClose' | 'clientIp'> &
  Omit<ForwardRoutesDeps, 'clientIp'> &
  Omit<BridgeSocketDeps, 'clientIp'> &
  StaticRoutesDeps & {
    /** Exact origins, besides the server's own, that may call machines. Defaults to none. */
    allowedOrigins?: readonly string[]
    /** True behind a proxy that sets `X-Forwarded-For`, which then gives the client IP. Defaults to false. */
    trustProxy?: boolean
    /** What the server API's routers share: the trusted origins and the `authenticate` hook. */
    api?: ServerRouterOptions
    /** The accounts modules of the server API. Null or missing means accounts are off, and none is mounted. */
    accounts?: { modules: readonly ApiModule[] } | null
  }

/**
 * The server's routes. Security headers wrap everything, and the origin check
 * wraps `/m/*`. The tunnel is mounted first, then the relay routes, then the
 * server API, and the static client last, so the client's `/m/<id>` pages
 * never shadow the relay and an unknown `/api` path never gets the client page.
 */
export function createApp(deps: AppDeps): Hono {
  const { forwarder, bridge, limiter } = deps
  const limits: LimitsDeps = { limiter, clientIp: clientIpReader({ trustProxy: deps.trustProxy }) }

  // The machine refused a key. Count it once against the browser that sent it; an unknown id or channel is ignored.
  const authFailed = (conn: MachineConnection, frame: Extract<MachineFrame, { type: 'auth.failed' }>) => {
    const ip =
      frame.id !== undefined
        ? forwarder.authFailed(conn, frame.id)
        : frame.channel !== undefined
          ? bridge.authFailed(conn, frame.channel)
          : undefined
    if (ip !== undefined) limiter.badKey(ip)
  }

  const app = new Hono()
  app.use(securityHeaders())
  app.use('/m/*', machineCors(new OriginPolicy(deps.allowedOrigins)))
  app.route(
    '/',
    createTunnelSocket({
      ...deps,
      ...limits,
      onFrame: (conn, frame) => {
        if (frame.type === 'auth.failed') {
          authFailed(conn, frame)
        } else if (frame.type === 'ws.data' || frame.type === 'ws.close' || frame.type === 'ws.ack') {
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
  app.route('/', createForwardRoutes({ ...deps, ...limits }))
  app.route('/', createBridgeSocket({ ...deps, ...limits }))
  const api = deps.api ?? {}
  app.route('/', createSystemRoutes(api))
  for (const module of deps.accounts?.modules ?? []) app.route('/', module(api))
  app.all('/api', () => serverErrorResponse(404, 'not_found'))
  app.all('/api/*', () => serverErrorResponse(404, 'not_found'))
  app.route('/', createStaticRoutes(deps))
  return app
}
