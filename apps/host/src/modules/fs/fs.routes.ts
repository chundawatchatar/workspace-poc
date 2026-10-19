import { routes } from '@orch/shared'
import { createRouter } from '../../lib/createRouter'
import { expandDir, listDirs, makeDir } from './fs.service'

export const fsRoutes = createRouter(routes.fs, {
  resolveDir: async ({ path }) => ({ path: expandDir(path) }),
  listDirs: async ({ path }) => listDirs(path),
  makeDir: async ({ parent, name }) => makeDir(parent, name),
})
