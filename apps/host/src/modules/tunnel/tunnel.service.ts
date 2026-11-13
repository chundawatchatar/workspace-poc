import {
  CLOSE_REPLACED,
  CLOSE_UNSUPPORTED_VERSION,
  decodeFrame,
  encodeFrame,
  type enrollFailedFrame,
  type enrollPreviewedFrame,
  type enrollPreviewFrame,
  type enrollRedeemedFrame,
  type enrollRedeemFrame,
  helloSignedMessage,
  type MachineFrame,
  type ServerFrame,
  serverFrame,
  TUNNEL_PATH,
  TUNNEL_PROTOCOL_VERSION,
  type TunnelState,
} from '@orch/shared'
import type { z } from 'zod'
import type { Principal } from '../../lib/principal'
import type { RecordAudit } from '../remote-access/audit-log.service'
import type { MachineKey } from './tunnel.repository'
import { type OpenChannel, type OpenSocket, TunnelChannels } from './tunnel-channels.service'
import { type Authorize, type SealedSessionLookup, type TunnelHandler, TunnelHttp } from './tunnel-http.service'
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

/** An enrollment frame to send, without its `id`, which `enroll` picks. */
export type EnrollRequest =
  | Omit<z.infer<typeof enrollPreviewFrame>, 'id'>
  | Omit<z.infer<typeof enrollRedeemFrame>, 'id'>

/** The server's answer to an `EnrollRequest`: `enroll.previewed` or `enroll.redeemed` to match it, or `enroll.failed`. */
export type EnrollAnswer =
  | z.infer<typeof enrollPreviewedFrame>
  | z.infer<typeof enrollRedeemedFrame>
  | z.infer<typeof enrollFailedFrame>

/** The answer each enrollment request waits for, besides `enroll.failed`. */
const ENROLL_ANSWER = { 'enroll.preview': 'enroll.previewed', 'enroll.redeem': 'enroll.redeemed' } as const

/** An enrollment request waiting for its answer. */
interface PendingEnroll {
  answer: EnrollAnswer['type']
  resolve: (frame: EnrollAnswer) => void
  reject: (error: Error) => void
  timer: Timer
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
  /** How long the server has, from the dial, to send `challenge` and then answer `hello` with `welcome`. */
  welcomeTimeoutMs: number
  /** How often the client pings the server. */
  pingIntervalMs: number
  /** How long the server may stay silent before the client drops the socket. */
  silenceTimeoutMs: number
  /** How long a connection must stay welcomed before the backoff starts again from the first attempt. */
  stableAfterMs: number
  /** How long the server has to answer an enrollment frame. */
  enrollTimeoutMs: number
  /** How often the wake watchdog compares the wall clock with its previous tick. */
  wakeCheckMs: number
  /** How far the wall clock may run ahead of the expected tick before the client counts it as waking from sleep. */
  wakeJumpMs: number
  /** How long the server has to answer the client's own `ping` with a `pong` of the same nonce. */
  pongTimeoutMs: number
}

const defaultTimings: TunnelTimings = {
  ...defaultBackoff,
  welcomeTimeoutMs: 10_000,
  pingIntervalMs: 20_000,
  silenceTimeoutMs: 45_000,
  stableAfterMs: 60_000,
  enrollTimeoutMs: 10_000,
  wakeCheckMs: 1000,
  wakeJumpMs: 10_000,
  pongTimeoutMs: 5000,
}

export interface TunnelClientOptions {
  /** The tunnel URL, from `parseServerUrl`. */
  url: string
  /** The machine key, which signs the server's `challenge` in `hello`. Only its public key and signatures leave the host. */
  key: MachineKey
  /** Decides every tunneled request and socket, by key or account. Nothing reaches `handle` or `openSocket` without it. */
  authorize: Authorize
  /** Answers each tunneled request. */
  handle: TunnelHandler
  /**
   * Finds the end-to-end session a sealed request or socket names. Without it, every sealed request gets the unsealed
   * 409 and every sealed socket `CLOSE_E2E_SESSION_UNKNOWN`.
   */
  e2eSession?: SealedSessionLookup
  /** Opens each tunneled WebSocket, or refuses it. */
  openSocket: OpenSocket
  /** The id this host expects the server to give it. A different one in `welcome` logs a warning. */
  expectedMachineId?: string
  timings?: Partial<TunnelTimings>
  /** Draws the backoff jitter, in `[0, 1)`. Defaults to `Math.random`. */
  random?: () => number
  /** Told each time `status` changes. */
  onStatus?: (state: TunnelState) => void
  /**
   * Told the account a `session.ended` frame names, once the server has
   * welcomed the tunnel. The frame is only the server's word, so the handler
   * decides what, if anything, to close.
   */
  onSessionEnded?: (accountId: string) => void
  /** Where tunneled sockets that open and close, and refused requests and sockets, are recorded. */
  record?: RecordAudit
  /** Opens the tunnel socket. Defaults to `new WebSocket(url)`; tests pass a fake one. */
  createSocket?: (url: string) => WebSocket
}

/** One socket and everything that lives only as long as it does. */
interface Connection {
  ws: WebSocket
  outbox: TunnelOutbox
  http: TunnelHttp
  channels: TunnelChannels
  /** True once the server's `challenge` was answered with `hello`. */
  challenged: boolean
  welcomed: boolean
  nonce: number
  /** Enrollment requests by id, until they are answered, time out or the connection ends. */
  enrolls: Map<number, PendingEnroll>
  /** The timeout of each of this client's pings, by nonce, until its `pong` arrives. */
  pongs: Map<number, Timer>
  timers: Timer[]
  silence?: Timer
}

/**
 * Keeps one outbound tunnel to the server open. It waits for the server's
 * `challenge`, answers with a `hello` signed by the machine key, waits for
 * `welcome`, keeps both heartbeats, answers tunneled HTTP requests through
 * `handle`, serves tunneled WebSockets through `openSocket` (both only once
 * `authorize` has accepted their access key or account), and reconnects
 * with backoff until `stop()`, a protocol version the server refuses, or
 * another host taking over this machine's tunnel. Every frame goes through
 * the connection's `TunnelOutbox`, so `ws.*` frames overtake response bodies.
 * A socket that looks open after sleep or a network change is caught by a
 * jump in the wall clock between watchdog ticks, which dials again at once,
 * or by a ping the server leaves unanswered.
 */
export class TunnelClient {
  private readonly timings: TunnelTimings
  private readonly random: () => number
  private conn: Connection | null = null
  private attempt = 0
  private enrollId = 0
  private reconnectTimer: Timer | undefined
  private watchdog: Timer | undefined
  /** The wall-clock time of the watchdog's previous tick. */
  private lastTick = 0
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
    this.watch()
    this.connect()
  }

  /**
   * Closes the tunnel with 1000 and cancels every timer and any pending
   * reconnect. With `remoteOff`, a welcomed connection first tells the server
   * the owner turned remote access off.
   */
  stop(options?: { remoteOff: true }) {
    this.stopped = true
    this.unwatch()
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    const conn = this.conn
    // Written straight to the socket, not through the outbox, which may hold it back and drops it on release. Data
    // queued before close() goes out before the close frame.
    if (options?.remoteOff && conn?.welcomed && conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(encodeFrame({ type: 'remote.off' }))
    }
    if (conn) this.release(conn)
    conn?.ws.close(1000, 'stopped')
    this.setState('off')
  }

  /** Closes the open tunneled sockets whose principal `revoked` matches with `code`; see `TunnelChannels.closeChannels`. */
  closeChannels(revoked: (principal: Principal) => boolean, reason: string, code?: number) {
    this.conn?.channels.closeChannels(revoked, reason, code)
  }

  /** The open, authorized tunneled sockets of the current connection; see `TunnelChannels.list`. Empty with none. */
  listChannels(): OpenChannel[] {
    return this.conn?.channels.list() ?? []
  }

  /**
   * Sends an enrollment frame with a fresh id and resolves with the server's
   * answer to it. Rejects when the tunnel is not welcomed, when the connection
   * ends first, or after `enrollTimeoutMs`. The key is never logged.
   */
  enroll(request: EnrollRequest): Promise<EnrollAnswer> {
    const conn = this.conn
    if (!conn?.welcomed) return Promise.reject(new Error('the tunnel is not connected'))
    const id = ++this.enrollId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.enrolls.delete(id)
        reject(new Error('the server did not answer'))
      }, this.timings.enrollTimeoutMs)
      conn.enrolls.set(id, { answer: ENROLL_ANSWER[request.type], resolve, reject, timer })
      this.send(conn, { ...request, id })
    })
  }

  private connect() {
    this.reconnectTimer = undefined
    this.setState('connecting')
    let ws: WebSocket
    try {
      ws = this.options.createSocket ? this.options.createSocket(this.options.url) : new WebSocket(this.options.url)
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
        this.options.record,
        this.options.e2eSession,
      ),
      channels: new TunnelChannels(this.options.openSocket, this.options.authorize, (frame) => this.send(conn, frame), {
        record: this.options.record,
        sessions: this.options.e2eSession,
      }),
      challenged: false,
      welcomed: false,
      nonce: 0,
      enrolls: new Map(),
      pongs: new Map(),
      timers: [],
    }
    this.conn = conn
    conn.timers.push(
      setTimeout(
        () => this.drop(conn, conn.challenged ? 'no welcome' : 'no challenge from server; is it up to date?'),
        this.timings.welcomeTimeoutMs,
      ),
    )

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
      case 'challenge':
        if (!conn.challenged) this.hello(conn, frame.nonce)
        return
      case 'welcome':
        if (conn.challenged && !conn.welcomed) this.welcomed(conn, frame.machineId)
        return
      case 'ping':
        this.send(conn, { type: 'pong', nonce: frame.nonce })
        return
      case 'pong':
        clearTimeout(conn.pongs.get(frame.nonce))
        conn.pongs.delete(frame.nonce)
        return
      case 'http.request':
        if (conn.welcomed) conn.http.request(frame)
        return
      case 'http.sealed':
        if (conn.welcomed) conn.http.sealed(frame)
        return
      case 'ws.open':
      case 'ws.sealed':
      case 'ws.data':
      case 'ws.close':
      case 'ws.ack':
        if (conn.welcomed) conn.channels.receive(frame)
        return
      case 'session.ended':
        if (conn.welcomed) this.options.onSessionEnded?.(frame.accountId)
        return
      case 'enroll.previewed':
      case 'enroll.redeemed':
      case 'enroll.failed': {
        const pending = conn.enrolls.get(frame.id)
        if (!pending || (frame.type !== 'enroll.failed' && frame.type !== pending.answer)) return
        conn.enrolls.delete(frame.id)
        clearTimeout(pending.timer)
        pending.resolve(frame)
        return
      }
    }
  }

  /** Answers the server's one `challenge` with `hello`, signing its nonce with the machine key. */
  private hello(conn: Connection, nonce: string) {
    conn.challenged = true
    const { key } = this.options
    this.send(conn, {
      type: 'hello',
      version: TUNNEL_PROTOCOL_VERSION,
      publicKey: key.publicKey,
      signature: key.sign(helloSignedMessage(nonce)),
    })
  }

  private welcomed(conn: Connection, machineId: string) {
    conn.welcomed = true
    this.setState('connected')
    for (const timer of conn.timers) clearTimeout(timer)
    console.log(`tunnel connected as ${machineId}`)
    const expected = this.options.expectedMachineId
    if (expected !== undefined && expected !== machineId) {
      console.warn(
        'warning: the server gave this machine another id than its machine key implies, so its connect link will not reach it',
      )
    }
    conn.timers = [
      setInterval(() => this.ping(conn), this.timings.pingIntervalMs),
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

  /** Pings the server and drops `conn` unless the matching `pong` arrives within `pongTimeoutMs`. */
  private ping(conn: Connection) {
    const nonce = ++conn.nonce
    conn.pongs.set(
      nonce,
      setTimeout(() => this.drop(conn, 'missed pong'), this.timings.pongTimeoutMs),
    )
    this.send(conn, { type: 'ping', nonce })
  }

  private send(conn: Connection, frame: MachineFrame) {
    if (this.conn === conn && conn.ws.readyState === WebSocket.OPEN) conn.outbox.send(frame)
  }

  /** Gives up on `conn`: its later events are ignored, its channels end, and nothing more is sent for them or its requests. */
  private release(conn: Connection) {
    this.conn = null
    for (const timer of conn.timers) clearTimeout(timer)
    clearTimeout(conn.silence)
    for (const timer of conn.pongs.values()) clearTimeout(timer)
    conn.pongs.clear()
    conn.http.close()
    conn.channels.close()
    conn.outbox.close()
    for (const pending of conn.enrolls.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('the tunnel closed'))
    }
    conn.enrolls.clear()
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
      this.unwatch()
      this.setState('stopped')
      console.error('tunnel refused: the server speaks another protocol version. Update this host to reconnect')
      return
    }
    if (code === CLOSE_REPLACED) {
      this.stopped = true
      this.unwatch()
      this.setState('stopped')
      console.error('tunnel closed: another host using this machine key took over. Not reconnecting')
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

  /**
   * Starts the wake watchdog. Bun's timers and the monotonic clock stand still
   * while macOS sleeps, so only `Date.now()` shows the gap.
   */
  private watch() {
    this.lastTick = Date.now()
    this.watchdog = setInterval(() => {
      const now = Date.now()
      const ahead = now - this.lastTick - this.timings.wakeCheckMs
      this.lastTick = now
      if (ahead > this.timings.wakeJumpMs) this.woke()
    }, this.timings.wakeCheckMs)
  }

  private unwatch() {
    clearInterval(this.watchdog)
    this.watchdog = undefined
  }

  /**
   * Replaces a connection that may have died during sleep, or cuts a pending
   * backoff short, and dials at once. The attempt counter is left alone, so a
   * dial that fails again backs off exactly as it would have without the wake.
   */
  private woke() {
    if (this.stopped) return
    const conn = this.conn
    if (conn) {
      this.release(conn)
      conn.ws.close(1000, 'woke from sleep')
      this.setState('reconnecting')
      console.log('tunnel lost (woke from sleep), reconnecting in 0 ms')
      this.connect()
    } else if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      console.log('tunnel woke from sleep, reconnecting in 0 ms')
      this.connect()
    }
  }

  private setState(state: TunnelState) {
    if (state === this.state) return
    this.state = state
    this.options.onStatus?.(state)
  }
}
