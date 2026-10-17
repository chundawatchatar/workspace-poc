import { z } from 'zod'
import { defineContract } from './contract'

export const resolveDirQuery = z.object({ path: z.string() })

/** `path` is null when the folder does not exist or the path is relative. */
export const resolveDirResponse = z.object({ path: z.string().nullable() })

export const fsContract = defineContract({
  resolveDir: {
    method: 'GET',
    path: '/api/fs/resolve-dir',
    description: 'Expands `~` and checks that the path is an existing directory, for the new workspace dialog.',
    input: resolveDirQuery,
    output: resolveDirResponse,
  },
})
