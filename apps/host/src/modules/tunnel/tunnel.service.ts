import {
  CLOSE_REPLACED,
  CLOSE_UNSUPPORTED_VERSION,
  decodeFrame,
  type MachineFrame,
  type ServerFrame,
  serverFrame,
  TUNNEL_PATH,
  TUNNEL_PROTOCOL_VERSION,
  type TunnelState,
} from '@orch/shared'
import { AUTH_TIMEOUT_MS, type OpenSocket, TunnelChannels } from './tunnel-channels.service'
import { type Authorize, type TunnelHandler, TunnelHttp } from './tunnel-http.service'
import { TunnelOutbox } from './tunnel-outbox.service'

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
  /** How long a tunneled socket has to send its auth message. */
  authTimeoutMs: number
}

const defaultTimings: TunnelTimings = {
  ...defaultBackoff,
  welcomeTimeoutMs: 10_000,
  pingIntervalMs: 20_000,
  silenceTimeoutMs: 45_000,
  stableAfterMs: 60_000,
  authTimeoutMs: AUTH_TIMEOUT_MS,
}

export interface TunnelClientOptions {
  /** The tunnel URL, from `parseServerUrl`. */
  url: string
  /** The machine secret, sent as the `hello` proof. */
  secret: string
  /** Decides every tunneled request's and socket's access key. Nothing reaches `handle` or `openSocket` without it. */
  authorize: Authorize
  /** Answers each tunneled request. */
  handle: TunnelHandler
  /** Opens each tunneled WebSocket, or refuses it. */
  openSocket: OpenSocket
  /** The id this host expects the server to give it. A different one in `welcome` logs a warning. */
  expectedMachineId?: string
  timings?: Partial<TunnelTimings>
  /** Draws the backoff jitter, in `[0, 1)`. Defaults to `Math.random`. */
  random?: () => number
  /** Told each time `status` changes. */
  onStatus?: (state: TunnelState) => void
}

/** One socket and everything that lives only as long as it does. */
interface Connection {
  ws: WebSocket
  outbox: TunnelOutbox
  http: TunnelHttp
  channels: TunnelChannels
  welcomed: boolean
  nonce: number
  timers: Timer[]
  silence?: Timer
}

/**
 * Keeps one outbound tunnel to the server open. It says `hello`, waits for
 * `welcome`, keeps both heartbeats, answers tunneled HTTP requests through
 * `handle`, serves tunneled WebSockets through `openSocket` (both only once
 * `authorize` has accepted their access key), and reconnects
 * with backoff until `stop()`, a protocol version the server refuses, or
 * another host taking over this machine's tunnel. Every frame goes through
 * the connection's `TunnelOutbox`, so `ws.*` frames overtake response bodies.
 */
export class TunnelClient {
  private readonly timings: TunnelTimings
  private readonly random: () => number
  private conn: Connection | null = null
  private attempt = 0
  private reconnectTimer: Timer | undefined
  private stopped = false
  private state: TunnelState = 'off'

  constructor(private readonly options: TunnelClientOptions) {
    this.timings = { ...defaultTimings, ...options.timings }
    this.random = options.random ?? Math.random
  }

  /** Where the tunnel stands. `off` before `start()` and after `stop()`. */
  get status(): TunnelState {
    return this.state
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
    this.setState('off')
  }

  /** Closes the open tunneled sockets authorized by any of `keyIds`, for a key that was rotated away. */
  closeChannels(keyIds: string[]) {
    this.conn?.channels.closeChannels(keyIds)
  }

  private connect() {
    this.reconnectTimer = undefined
    this.setState('connecting')
    let ws: WebSocket
    try {
      ws = new WebSocket(this.options.url)
    } catch {
      this.reconnect('dial failed')
      return
    }
    ws.binaryType = 'arraybuffer'
    const outbox = new TunnelOutbox({ write: (data) => ws.send(data), bufferedAmount: () => ws.bufferedAmount })
    const conn: Connection = {
      ws,
      outbox,
      http: new TunnelHttp(
        this.options.handle,
        this.options.authorize,
        (frame) => this.send(conn, frame),
        () => outbox.room(),
      ),
      channels: new TunnelChannels(this.options.openSocket, this.options.authorize, (frame) => this.send(conn, frame), {
        authTimeoutMs: this.timings.authTimeoutMs,
      }),
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
      case 'ws.data':
      case 'ws.close':
      case 'ws.ack':
        if (conn.welcomed) conn.channels.receive(frame)
        return
    }
  }

  private welcomed(conn: Connection, machineId: string) {
    conn.welcomed = true
    this.setState('connected')
    for (const timer of conn.timers) clearTimeout(timer)
    console.log(`tunnel connected as ${machineId}`)
    const expected = this.options.expectedMachineId
    if (expected !== undefined && expected !== machineId) {
      console.warn(
        'warning: the server gave this machine another id than its secret implies, so its connect link will not reach it',
      )
    }
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
    if (this.conn === conn && conn.ws.readyState === WebSocket.OPEN) conn.outbox.send(frame)
  }

  /** Gives up on `conn`: its later events are ignored, its channels end, and nothing more is sent for them or its requests. */
  private release(conn: Connection) {
    this.conn = null
    for (const timer of conn.timers) clearTimeout(timer)
    clearTimeout(conn.silence)
    conn.http.close()
    conn.channels.close()
    conn.outbox.close()
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
      this.setState('stopped')
      console.error('tunnel refused: the server speaks another protocol version. Update this host to reconnect')
      return
    }
    if (code === CLOSE_REPLACED) {
      this.stopped = true
      this.setState('stopped')
      console.error('tunnel closed: another host using this machine secret took over. Not reconnecting')
      return
    }
    this.reconnect(`closed with ${code}`)
  }

  private reconnect(reason: string) {
    if (this.stopped) return
    const delay = Math.round(backoffDelay(this.attempt, this.random, this.timings))
    this.attempt++
    this.setState('reconnecting')
    console.log(`tunnel lost (${reason}), reconnecting in ${delay} ms`)
    this.reconnectTimer = setTimeout(() => this.connect(), delay)
  }

  private setState(state: TunnelState) {
    if (state === this.state) return
    this.state = state
    this.options.onStatus?.(state)
  }
}
