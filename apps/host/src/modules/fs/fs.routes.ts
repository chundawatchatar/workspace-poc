import { routes } from '@orch/shared'
import { createRouter } from '../../lib/createRouter'
import { expandDir } from './fs.service'

export const fsRoutes = createRouter(routes.fs, {
  resolveDir: async ({ path }) => ({ path: expandDir(path) }),
})
