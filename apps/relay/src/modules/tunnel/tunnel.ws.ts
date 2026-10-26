import { upgradeWebSocket } from '@hono/bun'
import { decodeFrame, encodeFrame, machineFrame, TUNNEL_PATH, TUNNEL_PROTOCOL_VERSION } from '@orch/shared'
import { Hono } from 'hono'
import type { WSContext } from 'hono/ws'
import { z } from 'zod'
import { type MachineConnection, type MachineRegistry, machineIdFromProof } from './tunnel.service'

/** Close code for a `hello` with another protocol version. The machine should not retry until it is updated. */
export const CLOSE_UNSUPPORTED_VERSION = 4000
/** Close code for a tunnel that a newer connection from the same machine took over. */
export const CLOSE_REPLACED = 4001
/** Close code for a machine that sent nothing for `heartbeatTimeoutMs`. */
export const CLOSE_HEARTBEAT_TIMEOUT = 4002
/** Close code for a missing, invalid or repeated `hello`. */
const CLOSE_POLICY = 1008

/** What the tunnel socket needs from the relay. The timings are in milliseconds. */
export interface TunnelSocketDeps {
  registry: MachineRegistry
  /** How long a new socket has to send its `hello`. Defaults to 10 s. */
  helloTimeoutMs?: number
  /** How often the relay pings a machine. Defaults to 15 s. */
  pingIntervalMs?: number
  /** How long a machine may stay silent before it is dropped. Defaults to 45 s. */
  heartbeatTimeoutMs?: number
}

// Just enough of a `hello` to read its version, so a machine on another protocol
// version is told so even when the rest of its `hello` has changed shape.
const versionedHello = z.object({ type: z.literal('hello'), version: z.number() })

/** Serves `TUNNEL_PATH`, where each machine keeps one outbound tunnel. */
export function createTunnelSocket({
  registry,
  helloTimeoutMs = 10_000,
  pingIntervalMs = 15_000,
  heartbeatTimeoutMs = 45_000,
}: TunnelSocketDeps) {
  return new Hono().get(
    TUNNEL_PATH,
    upgradeWebSocket(() => {
      let conn: MachineConnection | null = null
      let closed = false
      let nonce = 0
      let helloTimer: Timer | undefined
      let pingTimer: Timer | undefined
      let heartbeatTimer: Timer | undefined

      // Stops the timers at once, so a replaced or failed tunnel goes quiet before its close event arrives.
      const shutdown = (ws: WSContext, code: number, reason: string) => {
        stopTimers()
        if (closed) return
        closed = true
        ws.close(code, reason)
      }
      const stopTimers = () => {
        clearTimeout(helloTimer)
        clearInterval(pingTimer)
        clearTimeout(heartbeatTimer)
      }

      const welcome = (ws: WSContext, proof: string) => {
        const live: MachineConnection = {
          machineId: machineIdFromProof(proof),
          send: (frame) => ws.send(encodeFrame(frame)),
          close: (code, reason) => shutdown(ws, code, reason),
        }
        conn = live
        registry.register(live)?.close(CLOSE_REPLACED, 'replaced')
        live.send({ type: 'welcome', machineId: live.machineId })
        heartbeatTimer = setTimeout(
          () => shutdown(ws, CLOSE_HEARTBEAT_TIMEOUT, 'heartbeat timeout'),
          heartbeatTimeoutMs,
        )
        pingTimer = setInterval(() => live.send({ type: 'ping', nonce: ++nonce }), pingIntervalMs)
      }

      return {
        onOpen(_event, ws) {
          helloTimer = setTimeout(() => shutdown(ws, CLOSE_POLICY, 'hello timeout'), helloTimeoutMs)
        },
        onMessage(event, ws) {
          if (closed) return
          const frame = decodeFrame(machineFrame, event.data)
          if (!conn) {
            clearTimeout(helloTimer)
            const version = frame?.type === 'hello' ? frame.version : decodeFrame(versionedHello, event.data)?.version
            if (version !== undefined && version !== TUNNEL_PROTOCOL_VERSION) {
              shutdown(ws, CLOSE_UNSUPPORTED_VERSION, 'unsupported version')
            } else if (frame?.type !== 'hello') {
              shutdown(ws, CLOSE_POLICY, 'expected hello')
            } else {
              welcome(ws, frame.proof)
            }
            return
          }
          if (!frame) return
          heartbeatTimer?.refresh()
          if (frame.type === 'hello') shutdown(ws, CLOSE_POLICY, 'unexpected hello')
          else if (frame.type === 'ping') conn.send({ type: 'pong', nonce: frame.nonce })
        },
        onClose() {
          closed = true
          stopTimers()
          if (conn) registry.remove(conn)
        },
      }
    }),
  )
}
