import { upgradeWebSocket } from '@hono/bun'
import { type AppState, type HostInfo, listSurfaces, parseMessage, routes } from '@orch/shared'
import { SessionManager } from '@orch/terminal'
import { Hono } from 'hono'
import type { LayoutRepository } from '../layout/layout.repository'
import type { EventClient, EventHub } from './events.service'

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

/** Serves `routes.sockets.events`. */
export function createEventsSocket({ hub, layout, sessions, info }: EventsSocketDeps) {
  return new Hono().get(
    routes.sockets.events.path,
    upgradeWebSocket(() => {
      let client: EventClient | null = null
      return {
        onOpen(_event, ws) {
          client = {
            id: crypto.randomUUID(),
            send: (event) => ws.send(JSON.stringify(event)),
          }
          hub.add(client)
          client.send({
            type: 'hello',
            clientId: client.id,
            state: layout.state,
            sessions: sessions.list().map((s) => s.info()),
            info,
          })
        },
        onMessage(event) {
          const message = parseMessage(routes.sockets.events.clientMessage, event.data)
          if (!message || !client) return
          if (message.type === 'state') {
            layout.set(message.state)
            hub.broadcast({ type: 'state', state: layout.state }, client)
            // A closed tab's terminal ends now. One opened moments ago may be missing only because this window's
            // layout is behind, so it is checked again once its grace period is over, against the layout by then.
            if (sessions.collect(liveSessionIds(layout.state))) {
              setTimeout(() => sessions.collect(liveSessionIds(layout.state)), SessionManager.GRACE + 100)
            }
          } else if (message.type === 'ack') {
            sessions.get(message.sessionId)?.ack()
          }
        },
        onClose() {
          if (client) hub.remove(client)
        },
      }
    }),
  )
}
