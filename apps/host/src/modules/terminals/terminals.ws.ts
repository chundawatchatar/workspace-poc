import { upgradeWebSocket } from '@hono/bun'
import { routes, type TermClientMsg } from '@orch/shared'
import type { ServerWebSocket } from 'bun'
import { type Context, Hono } from 'hono'
import { z } from 'zod'
import type { SessionManager, TermClient } from './terminals.service'

const socket = routes.sockets.terminal

const readInput = (c: Context) => socket.input.safeParse({ ...c.req.query(), ...c.req.param() })

/** Serves `routes.sockets.terminal`. A URL that fails its schema gets a 400 instead of a socket. */
export function createTerminalSocket(sessions: SessionManager) {
  return new Hono().get(
    socket.path,
    async (c, next) => {
      const input = readInput(c)
      if (!input.success) return c.json({ error: z.prettifyError(input.error) }, 400)
      await next()
    },
    upgradeWebSocket((c) => {
      // The middleware above already turned away URLs that fail the schema.
      const input = readInput(c)
      if (!input.success) throw input.error
      const { id, cwd, cols, rows } = input.data
      let client: TermClient | null = null
      return {
        onOpen(_event, ws) {
          const raw = ws.raw as ServerWebSocket
          client = {
            ready: false,
            queue: [],
            queued: 0,
            stale: false,
            want: null,
            send: (data) => raw.send(data),
            buffered: () => raw.getBufferedAmount(),
          }
          sessions.ensure(id, cwd, cols, rows).attach(client)
        },
        onMessage(event) {
          const session = sessions.get(id)
          if (typeof event.data !== 'string' || !session || !client) return
          const message = JSON.parse(event.data) as TermClientMsg
          if (message.type === 'input') session.input(message.data, client)
          else if (message.type === 'resize') session.resize(message.cols, message.rows, client)
          else if (message.type === 'focus') session.claim(client)
        },
        onClose() {
          if (client) sessions.get(id)?.detach(client)
        },
      }
    }),
  )
}
