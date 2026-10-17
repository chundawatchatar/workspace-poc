import { z } from 'zod'
import { defineContract } from './contract'

export const gitStatusQuery = z.object({ cwd: z.string() })

/** `branch` is null outside a git repository. */
export const gitStatusResponse = z.object({ branch: z.string().nullable(), changes: z.number() })

export type GitInfo = z.infer<typeof gitStatusResponse>

export const gitContract = defineContract({
  status: {
    method: 'GET',
    path: '/api/git/status',
    description: 'The branch and number of changed files in a workspace folder, for the sidebar.',
    input: gitStatusQuery,
    output: gitStatusResponse,
  },
})
