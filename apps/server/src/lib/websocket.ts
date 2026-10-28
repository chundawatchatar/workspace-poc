import { type BunWebSocketData, websocket } from '@hono/bun'
import { MAX_TUNNEL_FRAME_BYTES } from '@orch/shared'
import type { ServerWebSocket } from 'bun'
import type { WSContext, WSEvents } from 'hono/ws'

/** Hono's socket events plus `onDrain`, which Hono's Bun adapter does not have. */
export interface ServerSocketEvents extends WSEvents {
  /** Called when a backpressured socket can take more data. */
  onDrain?(): void
}

/**
 * The `websocket` handler for `Bun.serve`: Hono's, plus a `drain` hook that
 * reaches the socket's `onDrain`. Bun refuses messages over
 * `MAX_TUNNEL_FRAME_BYTES` before buffering them, on tunnels and browser
 * sockets alike.
 */
export const serverWebSocket = {
  ...websocket,
  maxPayloadLength: MAX_TUNNEL_FRAME_BYTES,
  drain(ws: ServerWebSocket<BunWebSocketData>) {
    ;(ws.data.events as ServerSocketEvents).onDrain?.()
  },
}

/** The Bun socket under a Hono socket context, for what Hono hides: send status and buffered amount. */
export function bunSocket(ws: WSContext): ServerWebSocket<BunWebSocketData> {
  return ws.raw as ServerWebSocket<BunWebSocketData>
}
