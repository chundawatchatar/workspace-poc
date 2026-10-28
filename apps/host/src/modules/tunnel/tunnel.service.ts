import {
  CLOSE_REPLACED,
  CLOSE_UNSUPPORTED_VERSION,
  decodeFrame,
  encodeFrame,
  type MachineFrame,
  type ServerFrame,
  serverFrame,
  TUNNEL_PATH,
  TUNNEL_PROTOCOL_VERSION,
} from '@orch/shared'
import { type TunnelHandler, TunnelHttp } from './tunnel-http.service'

const LOOPBACK_HOSTS = ['127.0.0.1', '[::1]', 'localhost']

/**
 * The tunnel URL for a `SERVER_URL` value, or null when it is not one: `wss:`
 * for any host, `ws:` only for a loopback host. A base path is kept, and
 * credentials, a query or a fragment are refused.
 */
export function parseServerUrl(value: string): string | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && LOOPBACK_HOSTS.includes(url.hostname))) return null
  if (!url.hostname || url.username || url.password || url.search || url.hash) return null
  url.pathname = url.pathname.replace(/\/+$/, '') + TUNNEL_PATH
  return url.href
}

/** The exponential backoff curve, in milliseconds. */
export interface Backoff {
  baseMs: number
  maxMs: number
}

const defaultBackoff: Backoff = { baseMs: 1000, maxMs: 30_000 }

/** How long to wait before reconnect `attempt` (from 0): full jitter over a doubling, capped window. */
export function backoffDelay(attempt: number, random: () => number, { baseMs, maxMs } = defaultBackoff): number {
  return random() * Math.min(maxMs, baseMs * 2 ** attempt)
}

/** The tunnel's timings, in milliseconds. */
export interface TunnelTimings extends Backoff {
  /** How long the server has to answer `hello` with `welcome`. */
  welcomeTimeoutMs: number
  /** How often the client pings the server. */
  pingIntervalMs: number
  /** How long the server may stay silent before the client drops the socket. */
  silenceTimeoutMs: number
  /** How long a connection must stay welcomed before the backoff starts again from the first attempt. */
  stableAfterMs: number
}

const defaultTimings: TunnelTimings = {
  ...defaultBackoff,
  welcomeTimeoutMs: 10_000,
  pingIntervalMs: 20_000,
  silenceTimeoutMs: 45_000,
  stableAfterMs: 60_000,
}

export interface TunnelClientOptions {
  /** The tunnel URL, from `parseServerUrl`. */
  url: string
  /** The machine secret, sent as the `hello` proof. */
  secret: string
  /** Answers each tunneled request. */
  handle: TunnelHandler
  timings?: Partial<TunnelTimings>
  /** Draws the backoff jitter, in `[0, 1)`. Defaults to `Math.random`. */
  random?: () => number
}

/** One socket and everything that lives only as long as it does. */
interface Connection {
  ws: WebSocket
  http: TunnelHttp
  welcomed: boolean
  nonce: number
  timers: Timer[]
  silence?: Timer
}

/**
 * Keeps one outbound tunnel to the server open. It says `hello`, waits for
 * `welcome`, keeps both heartbeats, answers tunneled HTTP requests through
 * `handle`, and reconnects with backoff until `stop()`, a protocol version
 * the server refuses, or another host taking over this machine's tunnel.
 */
export class TunnelClient {
  private readonly timings: TunnelTimings
  private readonly random: () => number
  private conn: Connection | null = null
  private attempt = 0
  private reconnectTimer: Timer | undefined
  private stopped = false

  constructor(private readonly options: TunnelClientOptions) {
    this.timings = { ...defaultTimings, ...options.timings }
    this.random = options.random ?? Math.random
  }

  start() {
    if (this.conn || this.reconnectTimer || this.stopped) return
    this.connect()
  }

  /** Closes the tunnel with 1000 and cancels every timer and any pending reconnect. */
  stop() {
    this.stopped = true
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    const conn = this.conn
    if (conn) this.release(conn)
    conn?.ws.close(1000, 'stopped')
  }

  private connect() {
    this.reconnectTimer = undefined
    let ws: WebSocket
    try {
      ws = new WebSocket(this.options.url)
    } catch {
      this.reconnect('dial failed')
      return
    }
    ws.binaryType = 'arraybuffer'
    const conn: Connection = {
      ws,
      http: new TunnelHttp(this.options.handle, (frame) => this.send(conn, frame)),
      welcomed: false,
      nonce: 0,
      timers: [],
    }
    this.conn = conn
    conn.timers.push(setTimeout(() => this.drop(conn, 'no welcome'), this.timings.welcomeTimeoutMs))

    ws.addEventListener('open', () => {
      if (this.conn === conn)
        this.send(conn, { type: 'hello', version: TUNNEL_PROTOCOL_VERSION, proof: this.options.secret })
    })
    ws.addEventListener('message', (event) => {
      if (this.conn !== conn) return
      const frame = decodeFrame(serverFrame, event.data)
      if (frame) this.receive(conn, frame)
    })
    ws.addEventListener('error', () => this.drop(conn, 'socket error'))
    ws.addEventListener('close', (event) => this.closed(conn, event.code))
  }

  private receive(conn: Connection, frame: ServerFrame) {
    this.heard(conn)
    switch (frame.type) {
      case 'welcome':
        if (!conn.welcomed) this.welcomed(conn, frame.machineId)
        return
      case 'ping':
        this.send(conn, { type: 'pong', nonce: frame.nonce })
        return
      case 'http.request':
        if (conn.welcomed) conn.http.request(frame)
        return
      case 'ws.open':
        // Tunneled WebSockets are not served yet. Closing at once tells the browser instead of leaving it waiting.
        this.send(conn, { type: 'ws.close', channel: frame.channel, code: 1011, reason: 'not supported' })
        return
    }
  }

  private welcomed(conn: Connection, machineId: string) {
    conn.welcomed = true
    for (const timer of conn.timers) clearTimeout(timer)
    console.log(`tunnel connected as ${machineId}`)
    conn.timers = [
      setInterval(() => this.send(conn, { type: 'ping', nonce: ++conn.nonce }), this.timings.pingIntervalMs),
      setTimeout(() => {
        if (this.conn === conn) this.attempt = 0
      }, this.timings.stableAfterMs),
    ]
    this.heard(conn)
  }

  /** Any valid frame shows the server is alive, so it restarts the silence timer of a welcomed connection. */
  private heard(conn: Connection) {
    if (!conn.welcomed) return
    clearTimeout(conn.silence)
    conn.silence = setTimeout(() => this.drop(conn, 'server went silent'), this.timings.silenceTimeoutMs)
  }

  private send(conn: Connection, frame: MachineFrame) {
    if (this.conn === conn && conn.ws.readyState === WebSocket.OPEN) conn.ws.send(encodeFrame(frame))
  }

  /** Gives up on `conn`: its later events are ignored, and nothing more is sent for its requests. */
  private release(conn: Connection) {
    this.conn = null
    for (const timer of conn.timers) clearTimeout(timer)
    clearTimeout(conn.silence)
    conn.http.close()
  }

  private drop(conn: Connection, reason: string) {
    if (this.conn !== conn) return
    this.release(conn)
    conn.ws.close(1000, reason)
    this.reconnect(reason)
  }

  private closed(conn: Connection, code: number) {
    if (this.conn !== conn) return
    this.release(conn)
    if (code === CLOSE_UNSUPPORTED_VERSION) {
      this.stopped = true
      console.error('tunnel refused: the server speaks another protocol version. Update this host to reconnect')
      return
    }
    if (code === CLOSE_REPLACED) {
      this.stopped = true
      console.error('tunnel closed: another host using this machine secret took over. Not reconnecting')
      return
    }
    this.reconnect(`closed with ${code}`)
  }

  private reconnect(reason: string) {
    if (this.stopped) return
    const delay = Math.round(backoffDelay(this.attempt, this.random, this.timings))
    this.attempt++
    console.log(`tunnel lost (${reason}), reconnecting in ${delay} ms`)
    this.reconnectTimer = setTimeout(() => this.connect(), delay)
  }
}
