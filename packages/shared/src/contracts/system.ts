import { z } from 'zod'
import { defineContract } from './contract'

export const healthResponse = z.object({ ok: z.boolean() })

export const systemContract = defineContract({
  health: {
    method: 'GET',
    path: '/api/health',
    description: 'Tells the web app the host is up.',
    input: z.object({}),
    output: healthResponse,
  },
})
