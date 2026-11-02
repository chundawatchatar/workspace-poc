import { type AppState, type ClientEvent, type HostInfo, listSurfaces, parseMessage, routes } from '@orch/shared'
import { SessionManager } from '@orch/terminal'
import { createRateLimiter } from '../../lib/rateLimit'
import { type SocketHandler, serveSocket } from '../../lib/socket'
import type { LayoutRepository } from '../layout/layout.repository'
import { DaemonSession } from '../terminals/daemon-session.service'
import type { EventClient, EventHub } from './events.service'

const socket = routes.sockets.events

/** What the events socket needs from the host. */
export interface EventsSocketDeps {
  hub: EventHub
  layout: LayoutRepository
  sessions: SessionManager
  info: HostInfo
}

function liveSessionIds(state: AppState) {
  return new Set(
    listSurfaces(state)
      .filter((s) => s.kind === 'terminal')
      .map((s) => s.id),
  )
}

/** Applies a client message about one terminal. A terminal that is gone is ignored. */
function applyToSession(sessions: SessionManager, message: Exclude<ClientEvent, { type: 'state' }>) {
  const session = sessions.get(message.sessionId)
  if (message.type === 'ack') session?.ack()
  else if (message.type === 'restore') session?.restore(message.mode)
  // Only the host's daemon sessions have the switch, so `TerminalSession` and the daemon build stay as they are.
  else if (session instanceof DaemonSession) session.setAgentTracking(message.on)
}

/** Adds each connection of `routes.sockets.events` to the hub, local or tunneled, and applies its layout changes. */
export function eventsSocketHandler({ hub, layout, sessions, info }: EventsSocketDeps): SocketHandler<typeof socket> {
  return (_input, conn) => {
    const limit = createRateLimiter()
    const client: EventClient = {
      id: crypto.randomUUID(),
      send: (event) => void conn.send(JSON.stringify(event)),
    }
    hub.add(client)
    client.send({
      type: 'hello',
      clientId: client.id,
      state: layout.state,
      sessions: sessions.list().map((s) => s.info()),
      info,
    })
    return {
      message(data) {
        // Checked before parsing, so frames that fail to parse count too.
        const decision = limit()
        if (decision === 'close') {
          console.warn(`closing ${socket.path} socket: it keeps sending past the rate limit`)
          conn.close(1008, 'rate limit')
        }
        if (decision !== 'accept') return
        const message = parseMessage(socket.clientMessage, data)
        if (!message) return
        if (message.type === 'state') {
          layout.set(message.state)
          hub.broadcast({ type: 'state', state: layout.state }, client)
          // A closed tab's terminal ends now. One opened moments ago may be missing only because this window's
          // layout is behind, so it is checked again once its grace period is over, against the layout by then.
          if (sessions.collect(liveSessionIds(layout.state))) {
            setTimeout(() => sessions.collect(liveSessionIds(layout.state)), SessionManager.GRACE + 100)
          }
        } else {
          applyToSession(sessions, message)
        }
      },
      close() {
        hub.remove(client)
      },
    }
  }
}

/** Serves `routes.sockets.events` locally. */
export function createEventsSocket(handler: SocketHandler<typeof socket>) {
  return serveSocket(socket, handler)
}
