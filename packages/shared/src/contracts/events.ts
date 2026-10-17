import { z } from 'zod'
import { defineSocket } from './contract'

/** Messages: `ServerEvent` from the host, `ClientEvent` from the client (see `protocol.ts`). */
export const eventsSocket = defineSocket({
  path: '/ws/events',
  description: 'Sends the layout and sessions on connect, then syncs layout changes between clients.',
  input: z.object({}),
})
