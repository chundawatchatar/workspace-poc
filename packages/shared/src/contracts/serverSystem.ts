import { z } from 'zod'
import { defineServerContract } from './server'

export const serverHealthResponse = z.object({ ok: z.literal(true) })

export const serverSystemContract = defineServerContract({
  health: {
    method: 'GET',
    path: '/api/health',
    description: 'Tells callers and uptime checks the server is up.',
    auth: 'public',
    input: z.object({}),
    output: serverHealthResponse,
  },
})
