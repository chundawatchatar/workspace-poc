import { routes } from '@orch/shared'
import { createRouter } from '../../lib/createRouter'
import { getGitStatus } from './git.service'

export const gitRoutes = createRouter(routes.git, {
  status: async ({ cwd }) => getGitStatus(cwd),
})
