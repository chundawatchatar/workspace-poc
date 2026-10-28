import { parseMessage, routes } from '@orch/shared'
import type { SessionManager, TermClient } from '@orch/terminal'
import { createRateLimiter } from '../../lib/rateLimit'
import { type SocketHandler, serveSocket } from '../../lib/socket'

const socket = routes.sockets.terminal

/** Attaches each connection of `routes.sockets.terminal` to its session, local or tunneled. */
export function terminalSocketHandler(sessions: SessionManager): SocketHandler<typeof socket> {
  return ({ id, cwd, cols, rows }, conn) => {
    const limit = createRateLimiter()
    const client: TermClient = {
      ready: false,
      queue: [],
      queued: 0,
      stale: false,
      want: null,
      answers: false,
      send: (data) => conn.send(data),
      buffered: () => conn.buffered(),
    }
    sessions.ensure(id, cwd, cols, rows).attach(client)
    return {
      message(data) {
        // Checked before parsing, so frames that fail to parse count too.
        const decision = limit()
        if (decision === 'close') {
          console.warn(`closing ${socket.path} socket for terminal ${id}: it keeps sending past the rate limit`)
          conn.close(1008, 'rate limit')
        }
        if (decision !== 'accept') return
        const session = sessions.get(id)
        const message = parseMessage(socket.clientMessage, data)
        if (!message || !session) return
        if (message.type === 'input') session.input(message.data, client)
        else if (message.type === 'resize') session.resize(message.cols, message.rows, client)
        else if (message.type === 'focus') session.claim(client)
        else if (message.type === 'clear') session.clear()
        else if (message.type === 'colors') {
          const { type: _type, ...palette } = message
          session.colors(palette)
        }
      },
      close() {
        sessions.get(id)?.detach(client)
      },
    }
  }
}

/** Serves `routes.sockets.terminal` locally. A URL that fails its schema gets a 400 instead of a socket. */
export function createTerminalSocket(handler: SocketHandler<typeof socket>) {
  return serveSocket(socket, handler)
}
