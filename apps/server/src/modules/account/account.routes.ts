import { serverRoutes } from '@orch/shared'
import type { ApiModule } from '../../app'
import { createServerRouter } from '../../lib/createServerRouter'

/** Builds the module that serves `serverRoutes.account`: `GET /api/me`, read from the session without a query. */
export function createAccountModule(): ApiModule {
  return (options) =>
    createServerRouter(
      serverRoutes.account,
      { me: async (_input, { principal }) => ({ id: principal.userId, email: principal.email, name: principal.name }) },
      options,
    )
}
