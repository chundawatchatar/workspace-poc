import { upgradeWebSocket } from '@hono/bun'
import type { Socket } from '@orch/shared'
import type { ServerWebSocket } from 'bun'
import { type Context, Hono } from 'hono'
import type { WSContext } from 'hono/ws'
import { z } from 'zod'

/** A WebSocket message: a string is a text message and bytes a binary one. */
export type SocketData = string | Uint8Array

/** The one connection a socket handler talks to, local or tunneled. */
export interface SocketConn {
  /** Bun's result: bytes sent, -1 when queued under backpressure, 0 when the message was dropped. */
  send(data: SocketData): number
  /** Bytes accepted but not yet delivered. */
  buffered(): number
  close(code?: number, reason?: string): void
}

/** What a handler does with one open connection. */
export interface SocketSession {
  /** A message from the client. */
  message(data: SocketData): void
  /** The connection closed, from either end. Runs once. */
  close(): void
}

/** Serves one connection of `S`, given its parsed URL input. */
export type SocketHandler<S extends Socket> = (input: z.infer<S['input']>, conn: SocketConn) => SocketSession

/** Bun's socket under a Hono socket context, as a `SocketConn`. */
function bunConn(ws: WSContext): SocketConn {
  const raw = ws.raw as ServerWebSocket
  return {
    send: (data) => raw.send(data),
    buffered: () => raw.getBufferedAmount(),
    close: (code, reason) => ws.close(code, reason),
  }
}

/** A Hono message as `SocketData`, or null for a kind Bun never delivers. */
function messageData(data: unknown): SocketData | null {
  if (typeof data === 'string' || data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return null
}

/** Serves `socket` on its path with `handler`. A URL that fails the socket's input schema gets a 400 instead. */
export function serveSocket<S extends Socket>(socket: S, handler: SocketHandler<S>) {
  const readInput = (c: Context) => socket.input.safeParse({ ...c.req.query(), ...c.req.param() })
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
      // `safeParse` on a generic schema loses its output type, which `S` still has.
      const parsed = input.data as z.infer<S['input']>
      let session: SocketSession | null = null
      return {
        onOpen(_event, ws) {
          session = handler(parsed, bunConn(ws))
        },
        onMessage(event) {
          const data = messageData(event.data)
          if (data !== null) session?.message(data)
        },
        onClose() {
          session?.close()
          session = null
        },
      }
    }),
  )
}
