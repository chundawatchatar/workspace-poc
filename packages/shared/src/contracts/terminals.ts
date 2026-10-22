import { z } from 'zod'
import { defineSocket } from './contract'

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/)

/** A terminal theme's colours as `#rrggbb`: `ansi` holds the 16 base colours, black through bright white. */
export const termColors = z.object({
  foreground: hex.optional(),
  background: hex.optional(),
  cursor: hex.optional(),
  ansi: z.array(hex).length(16).optional(),
})

/**
 * Messages: `clientMessage` (`TermClientMsg`) from the client and `TermServerMsg` from the host
 * (see `protocol.ts`). Terminal output travels as binary frames.
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
  clientMessage: z.discriminatedUnion('type', [
    z.object({ type: z.literal('input'), data: z.string().max(64 * 1024) }),
    /** The size this view's pane can show. The host applies it only for the view in control. */
    z.object({
      type: z.literal('resize'),
      cols: z.number().int().min(2).max(1000),
      rows: z.number().int().min(2).max(1000),
    }),
    /** This view was focused, so the session should take its size. */
    z.object({ type: z.literal('focus') }),
    /** Clears the screen and scrollback, keeping the current line, in every view of the session. */
    z.object({ type: z.literal('clear') }),
    /** The view's theme, so a host that answers terminal queries itself reports the colours the user sees. */
    z.object({ type: z.literal('colors'), ...termColors.shape }),
  ]),
})
