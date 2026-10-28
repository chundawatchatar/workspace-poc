import { upgradeWebSocket } from '@hono/bun'
import { MACHINE_WS_ROUTE, WS_PREFIX } from '@orch/shared'
import { Hono } from 'hono'
import type { WSContext } from 'hono/ws'
import { relayedPath, relayedSocketHeaders } from '../../lib/relay'
import { bunSocket, type ServerSocketEvents } from '../../lib/websocket'
import type { BrowserChannel, BrowserSocket, ChannelBridge } from './bridge.service'

/** What the bridge socket needs from the server. */
export interface BridgeSocketDeps {
  bridge: ChannelBridge
}

/**
 * Serves `MACHINE_WS_ROUTE` by bridging each browser socket to a channel on its
 * machine's tunnel. A socket for an offline machine is accepted and then closed
 * with a code, because a browser cannot read why an upgrade failed.
 */
export function createBridgeSocket({ bridge }: BridgeSocketDeps) {
  return new Hono().get(
    MACHINE_WS_ROUTE,
    (c, next) => (relayedPath(c.req.url, WS_PREFIX) ? next() : c.notFound()),
    upgradeWebSocket((c) => {
      // Hono hands out the `machineId` param already URI-decoded.
      const machineId = c.req.param('machineId') ?? ''
      const path = relayedPath(c.req.url, WS_PREFIX) ?? ''
      const headers = relayedSocketHeaders(c.req.raw.headers)
      let channel: BrowserChannel | null = null
      const events: ServerSocketEvents = {
        onOpen(_event, ws) {
          channel = bridge.open(machineId, path, headers, browserSocket(ws))
        },
        onMessage(event) {
          const { data } = event
          if (typeof data === 'string') channel?.message(data)
          else if (data instanceof ArrayBuffer) channel?.message(new Uint8Array(data))
        },
        onDrain() {
          channel?.drained()
        },
        onClose(event) {
          channel?.closed(event.code, event.reason)
          channel = null
        },
      }
      return events
    }),
  )
}

function browserSocket(ws: WSContext): BrowserSocket {
  const raw = bunSocket(ws)
  return {
    // Bun answers -1 when it queued the message behind backpressure.
    send: (data) => raw.send(data) !== -1,
    close: (code, reason) => raw.close(code, reason),
  }
}
