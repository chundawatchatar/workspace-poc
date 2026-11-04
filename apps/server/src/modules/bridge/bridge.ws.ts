import { upgradeWebSocket } from '@hono/bun'
import { CLOSE_RATE_LIMITED, MACHINE_WS_ROUTE, WS_PREFIX } from '@orch/shared'
import { Hono } from 'hono'
import type { WSContext } from 'hono/ws'
import { relayedPath, relayedSocketHeaders } from '../../lib/relay'
import { bunSocket, type ServerSocketEvents } from '../../lib/websocket'
import type { LimitsDeps } from '../limits/limits.middleware'
import type { RelayAccount } from '../machines/relay-account.service'
import type { BrowserChannel, BrowserSocket, ChannelBridge } from './bridge.service'

/** What the bridge socket needs from the server. */
export interface BridgeSocketDeps extends LimitsDeps {
  bridge: ChannelBridge
  /** Says which account opened a relayed socket. Null or missing means accounts are off, and none is sent. */
  relayAccount?: RelayAccount | null
}

/**
 * Serves `MACHINE_WS_ROUTE` by bridging each browser socket to a channel on its
 * machine's tunnel, with the account `relayAccount` answers. A socket for an offline machine, or one refused by a rate
 * limit, is accepted and then closed with a code, because a browser cannot
 * read why an upgrade failed. The origin check runs before this, for all of
 * `/m/*`, in `app.ts`.
 */
export function createBridgeSocket({ bridge, limiter, clientIp, relayAccount }: BridgeSocketDeps) {
  return new Hono().get(
    MACHINE_WS_ROUTE,
    (c, next) => (relayedPath(c.req.url, WS_PREFIX) ? next() : c.notFound()),
    upgradeWebSocket(async (c) => {
      // Hono hands out the `machineId` param already URI-decoded.
      const machineId = c.req.param('machineId') ?? ''
      const path = relayedPath(c.req.url, WS_PREFIX) ?? ''
      const headers = relayedSocketHeaders(c.req.raw.headers)
      const ip = clientIp(c)
      const admission = limiter.admitBrowser(ip, machineId)
      // Read once per upgrade, from the upgrade request's session; the socket's messages never carry it.
      const accountId = admission.ok && relayAccount ? await relayAccount(c, machineId) : null
      let channel: BrowserChannel | null = null
      const events: ServerSocketEvents = {
        onOpen(_event, ws) {
          if (!admission.ok) {
            ws.close(CLOSE_RATE_LIMITED, 'rate limited')
            return
          }
          channel = bridge.open(machineId, path, headers, browserSocket(ws), ip, accountId)
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
