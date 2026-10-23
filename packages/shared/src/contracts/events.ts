import { z } from 'zod'
import type { AppState } from '../model'
import { defineSocket } from './contract'

/** Messages: `ServerEvent` from the host, `clientMessage` (`ClientEvent`) from the client (see `protocol.ts`). */
export const eventsSocket = defineSocket({
  path: '/ws/events',
  description: 'Sends the layout and sessions on connect, then syncs layout changes between clients.',
  input: z.object({}),
  clientMessage: z.discriminatedUnion('type', [
    // The layout is the client's own reducer output, so only its outline is checked.
    z.object({
      type: z.literal('state'),
      state: z.custom<AppState>((value) => {
        const state = value as AppState | null
        return typeof state === 'object' && state !== null && Array.isArray(state.workspaces)
      }),
    }),
    z.object({ type: z.literal('ack'), sessionId: z.string() }),
    /** Starts an interrupted terminal again: its agent on the saved conversation, or a plain shell. */
    z.object({ type: z.literal('restore'), sessionId: z.string(), mode: z.enum(['agent', 'shell']) }),
  ]),
})
