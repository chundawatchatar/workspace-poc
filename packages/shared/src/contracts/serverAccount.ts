import { z } from 'zod'
import { defineServerContract } from './server'

/** The signed-in user, as `GET /api/me` returns them. */
export const serverMeResponse = z.object({ id: z.string(), email: z.string(), name: z.string() })
export type ServerMe = z.infer<typeof serverMeResponse>

export const serverAccountContract = defineServerContract({
  me: {
    method: 'GET',
    path: '/api/me',
    description: 'Tells the client who is signed in, to show the account and decide what to offer.',
    input: z.object({}),
    output: serverMeResponse,
  },
})
