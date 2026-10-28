import { upgradeWebSocket } from '@hono/bun'
import {
  CLOSE_HEARTBEAT_TIMEOUT,
  CLOSE_REPLACED,
  CLOSE_UNSUPPORTED_VERSION,
  decodeFrame,
  FrameScheduler,
  type MachineFrame,
  machineFrame,
  type ServerFrame,
  TUNNEL_PATH,
  TUNNEL_PROTOCOL_VERSION,
} from '@orch/shared'
import { Hono } from 'hono'
import type { WSContext } from 'hono/ws'
import { z } from 'zod'
import { bunSocket, type ServerSocketEvents } from '../../lib/websocket'
import { type LimitsDeps, limitTunnelUpgrades } from '../limits/limits.middleware'
import { type MachineConnection, type MachineRegistry, machineIdFromProof } from './tunnel.service'

/** Close code for a missing, invalid or repeated `hello`. */
const CLOSE_POLICY = 1008

/** What the tunnel socket needs from the server. The timings are in milliseconds. */
export interface TunnelSocketDeps extends LimitsDeps {
  registry: MachineRegistry
  /** How long a new socket has to send its `hello`. Defaults to 10 s. */
  helloTimeoutMs?: number
  /** How often the server pings a machine. Defaults to 15 s. */
  pingIntervalMs?: number
  /** How long a machine may stay silent before it is dropped. Defaults to 45 s. */
  heartbeatTimeoutMs?: number
  /** Receives the `http.*` and `ws.*` frames of a welcomed machine. */
  onFrame?(conn: MachineConnection, frame: MachineFrame): void
  /** Called once when a welcomed machine's tunnel closes, is dropped or is replaced. */
  onClose?(conn: MachineConnection): void
}

// Just enough of a `hello` to read its version, so a machine on another protocol
// version is told so even when the rest of its `hello` has changed shape.
const versionedHello = z.object({ type: z.literal('hello'), version: z.number() })

/** Serves `TUNNEL_PATH`, where each machine keeps one outbound tunnel. Upgrades are rate limited per IP. */
export function createTunnelSocket({
  limiter,
  clientIp,
  registry,
  helloTimeoutMs = 10_000,
  pingIntervalMs = 15_000,
  heartbeatTimeoutMs = 45_000,
  onFrame,
  onClose,
}: TunnelSocketDeps) {
  return new Hono().get(
    TUNNEL_PATH,
    limitTunnelUpgrades({ limiter, clientIp }),
    upgradeWebSocket(() => {
      let conn: MachineConnection | null = null
      let closed = false
      let released = false
      let nonce = 0
      let helloTimer: Timer | undefined
      let pingTimer: Timer | undefined
      let heartbeatTimer: Timer | undefined
      let scheduler: FrameScheduler<ServerFrame> | undefined

      // Stops the timers and releases the tunnel at once, so a replaced or failed tunnel goes quiet,
      // and its pending requests fail, before its close event arrives.
      const shutdown = (ws: WSContext, code: number, reason: string) => {
        stopTimers()
        scheduler?.clear()
        release()
        if (closed) return
        closed = true
        ws.close(code, reason)
      }
      const stopTimers = () => {
        clearTimeout(helloTimer)
        clearInterval(pingTimer)
        clearTimeout(heartbeatTimer)
      }

      const release = () => {
        if (!conn || released) return
        released = true
        registry.remove(conn)
        onClose?.(conn)
      }

      const welcome = (ws: WSContext, proof: string) => {
        // `http.request` goes in the bulk lane, so a large upload never holds back terminal traffic.
        const lanes = new FrameScheduler<ServerFrame>({
          write: (data) => ws.send(data),
          bufferedAmount: () => bunSocket(ws).getBufferedAmount(),
          lane: (frame) => (frame.type === 'http.request' ? 'bulk' : 'interactive'),
        })
        scheduler = lanes
        const live: MachineConnection = {
          machineId: machineIdFromProof(proof),
          send: (frame) => {
            if (!closed) lanes.send(frame)
          },
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

      const greet = (ws: WSContext, frame: MachineFrame | null, data: unknown) => {
        clearTimeout(helloTimer)
        const version = frame?.type === 'hello' ? frame.version : decodeFrame(versionedHello, data)?.version
        if (version !== undefined && version !== TUNNEL_PROTOCOL_VERSION) {
          shutdown(ws, CLOSE_UNSUPPORTED_VERSION, 'unsupported version')
        } else if (frame?.type !== 'hello') {
          shutdown(ws, CLOSE_POLICY, 'expected hello')
        } else {
          welcome(ws, frame.proof)
        }
      }

      const events: ServerSocketEvents = {
        onOpen(_event, ws) {
          helloTimer = setTimeout(() => shutdown(ws, CLOSE_POLICY, 'hello timeout'), helloTimeoutMs)
        },
        onMessage(event, ws) {
          if (closed) return
          const frame = decodeFrame(machineFrame, event.data)
          if (!conn) {
            greet(ws, frame, event.data)
            return
          }
          if (!frame) return
          heartbeatTimer?.refresh()
          if (frame.type === 'hello') shutdown(ws, CLOSE_POLICY, 'unexpected hello')
          else if (frame.type === 'ping') conn.send({ type: 'pong', nonce: frame.nonce })
          else if (frame.type !== 'pong') onFrame?.(conn, frame)
        },
        onDrain() {
          if (!closed) scheduler?.flush()
        },
        onClose() {
          closed = true
          stopTimers()
          scheduler?.clear()
          release()
        },
      }
      return events
    }),
  )
}
