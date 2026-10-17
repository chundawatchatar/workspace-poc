import { routes } from '@orch/shared'
import { createRouter } from '../../lib/createRouter'

export const systemRoutes = createRouter(routes.system, {
  health: async () => ({ ok: true }),
})
