import { upgradeWebSocket } from '@hono/bun'
import {
  CLOSE_RATE_LIMITED,
  MACHINE_SEALED_SOCKET_ROUTE,
  MACHINE_WS_ROUTE,
  MAX_E2E_ENVELOPE_BYTES,
  WS_PREFIX,
} from '@orch/shared'
import { Hono } from 'hono'
import type { WSContext } from 'hono/ws'
import { relayedPath, relayedSocketHeaders } from '../../lib/relay'
import { bunSocket, type ServerSocketEvents } from '../../lib/websocket'
import type { LimitsDeps } from '../limits/limits.middleware'
import { type BrowserChannel, type BrowserSocket, type ChannelBridge, CLOSE_POLICY } from './bridge.service'

/** How long a sealed socket has to send its envelope, its first message, before the server closes it. */
export const SEALED_OPEN_TIMEOUT_MS = 10_000

/** What the bridge socket needs from the server. */
export interface BridgeSocketDeps extends LimitsDeps {
  bridge: ChannelBridge
}

/**
 * Serves `MACHINE_WS_ROUTE` and `MACHINE_SEALED_SOCKET_ROUTE` by bridging each browser socket to a channel on its
 * machine's tunnel. A socket for an offline machine, or one refused by a rate
 * limit, is accepted and then closed with a code, because a browser cannot
 * read why an upgrade failed. The origin check runs before this, for all of
 * `/m/*`, in `app.ts`.
 *
 * A sealed socket reads no request header and forwards no header or
 * subprotocol: its channel opens only when its first message arrives, which
 * must be a binary envelope of at most `MAX_E2E_ENVELOPE_BYTES`, within
 * `SEALED_OPEN_TIMEOUT_MS`. Otherwise it is closed with 1008 and nothing is
 * sent. The envelope goes unread as `ws.sealed`, and the channel then works
 * like any other.
 */
export function createBridgeSocket({ bridge, limiter, clientIp }: BridgeSocketDeps) {
  return new Hono()
    .get(
      MACHINE_SEALED_SOCKET_ROUTE,
      upgradeWebSocket((c) => {
        // Hono hands out the `machineId` param already URI-decoded.
        const machineId = c.req.param('machineId') ?? ''
        const ip = clientIp(c)
        const admission = limiter.admitBrowser(ip, machineId)
        let channel: BrowserChannel | null = null
        /** Runs out when no envelope arrives in time. Cleared by the first message. */
        let openTimer: Timer | undefined
        /** True until the first message, the envelope, has arrived. */
        let waiting = false
        const events: ServerSocketEvents = {
          onOpen(_event, ws) {
            if (!admission.ok) {
              ws.close(CLOSE_RATE_LIMITED, 'rate limited')
              return
            }
            waiting = true
            openTimer = setTimeout(() => {
              waiting = false
              ws.close(CLOSE_POLICY, 'no envelope')
            }, SEALED_OPEN_TIMEOUT_MS)
          },
          onMessage(event, ws) {
            const { data } = event
            if (channel) {
              if (typeof data === 'string') channel.message(data)
              else if (data instanceof ArrayBuffer) channel.message(new Uint8Array(data))
              return
            }
            if (!waiting) return
            waiting = false
            clearTimeout(openTimer)
            if (!(data instanceof ArrayBuffer) || data.byteLength > MAX_E2E_ENVELOPE_BYTES) {
              ws.close(CLOSE_POLICY, 'bad envelope')
              return
            }
            channel = bridge.openSealed(machineId, new Uint8Array(data), browserSocket(ws), ip)
          },
          onDrain() {
            channel?.drained()
          },
          onClose(event) {
            waiting = false
            clearTimeout(openTimer)
            channel?.closed(event.code, event.reason)
            channel = null
          },
        }
        return events
      }),
    )
    .get(
      MACHINE_WS_ROUTE,
      (c, next) => (relayedPath(c.req.url, WS_PREFIX) ? next() : c.notFound()),
      upgradeWebSocket((c) => {
        // Hono hands out the `machineId` param already URI-decoded.
        const machineId = c.req.param('machineId') ?? ''
        const path = relayedPath(c.req.url, WS_PREFIX) ?? ''
        const headers = relayedSocketHeaders(c.req.raw.headers)
        const ip = clientIp(c)
        const admission = limiter.admitBrowser(ip, machineId)
        let channel: BrowserChannel | null = null
        const events: ServerSocketEvents = {
          onOpen(_event, ws) {
            if (!admission.ok) {
              ws.close(CLOSE_RATE_LIMITED, 'rate limited')
              return
            }
            channel = bridge.open(machineId, path, headers, browserSocket(ws), ip)
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
