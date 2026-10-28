import { z } from 'zod'
import { defineContract } from './contract'

export const rotateAccessResponse = z.object({
  machineId: z.string().min(1),
  /** The new access key. This response is the only place it is ever shown. */
  key: z.string().min(1),
  /** The connect link for the new key. Null means the host knows no client URL to build it on. */
  link: z.string().nullable(),
})
export type RotateAccessResponse = z.infer<typeof rotateAccessResponse>

export const accessContract = defineContract({
  rotate: {
    method: 'POST',
    path: '/api/access/rotate',
    description:
      'Replaces the access key and closes every remote session that used the old one. Local callers only (`bun run host:rotate-key`).',
    input: z.object({}),
    output: rotateAccessResponse,
  },
})
