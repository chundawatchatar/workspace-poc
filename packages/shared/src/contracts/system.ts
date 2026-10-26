import { z } from 'zod'
import { defineContract } from './contract'

export const healthResponse = z.object({ ok: z.boolean() })

export const daemonResponse = z.object({
  /** How long the terminal daemon has been running. Null means it is not known to be up. */
  uptimeMs: z.number().int().nonnegative().nullable(),
  /** Terminals whose shell is still running. */
  liveTerminals: z.number().int().nonnegative(),
})
export type DaemonReport = z.infer<typeof daemonResponse>

export const systemContract = defineContract({
  health: {
    method: 'GET',
    path: '/api/health',
    description: 'Tells the web app the host is up.',
    input: z.object({}),
    output: healthResponse,
  },
  daemon: {
    method: 'GET',
    path: '/api/daemon',
    description: 'Reports how long the terminal daemon has been up and how many terminals are live.',
    input: z.object({}),
    output: daemonResponse,
  },
})
