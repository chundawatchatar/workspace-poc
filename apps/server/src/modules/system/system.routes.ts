import { serverRoutes } from '@orch/shared'
import type { Hono } from 'hono'
import { createServerRouter, type ServerRouterOptions } from '../../lib/createServerRouter'

/** `GET /api/health`, public, which tells uptime checks the server is up. */
export function createSystemRoutes(options: ServerRouterOptions): Hono {
  return createServerRouter(serverRoutes.system, { health: async () => ({ ok: true as const }) }, options)
}
