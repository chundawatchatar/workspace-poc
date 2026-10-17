import { z } from 'zod'
import { defineSocket } from './contract'

/**
 * Messages: `TermClientMsg` from the client and `TermServerMsg` from the host (see `protocol.ts`).
 * Terminal output travels as binary frames.
 */
export const terminalSocket = defineSocket({
  path: '/ws/term/:id',
  description: 'Attaches a view to a shell session, starting the shell in `cwd` at the given size if needed.',
  input: z.object({
    /** The session id, which is also the terminal surface's id. */
    id: z.string().min(1),
    cwd: z.string().default(''),
    cols: z.coerce.number().int().positive().default(80),
    rows: z.coerce.number().int().positive().default(24),
  }),
})
