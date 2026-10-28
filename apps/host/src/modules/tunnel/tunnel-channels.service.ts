import {
  CLOSE_ACCESS_DENIED,
  encodeFrame,
  MAX_TUNNEL_FRAME_BYTES,
  type MachineFrame,
  parseMessage,
  type ServerFrame,
  socketAuthMessage,
  WS_CHANNEL_WINDOW_BYTES,
  wsPayloadBytes,
} from '@orch/shared'
import type { Principal } from '../../lib/principal'
import type { SocketConn, SocketData, SocketSession } from '../../lib/socket'
import type { SocketRefusal } from '../../lib/socketRouter'
import type { Authorize } from './tunnel-http.service'

/**
 * Opens the socket a `ws.open` asks for, as the key that authorized it, or
 * says why not. In the host this is the app's `SocketRouter`.
 */
export type OpenSocket = (
  path: string,
  headers: [string, string][],
  conn: SocketConn,
  principal: Principal,
) => SocketSession | SocketRefusal

/** How long a channel has to send its auth message before it is closed. */
export const AUTH_TIMEOUT_MS = 10_000

/** The most payload bytes a channel may queue while it waits for window. Past it, the channel closes with 1011. */
export const CHANNEL_QUEUE_CAP_BYTES = 4 * 1024 * 1024

/** Close code for a message that does not fit in one tunnel frame. */
const CLOSE_TOO_BIG = 1009
/** Close code for a channel whose client stopped taking its messages, or whose handler failed. */
const CLOSE_INTERNAL_ERROR = 1011

// The most `ws.data` overhead a string payload can need: JSON escapes take at
// most 6 bytes per UTF-16 unit, plus the frame's other fields.
const MAX_ESCAPE_BYTES = 6
const FRAME_OVERHEAD_BYTES = 64

const encoder = new TextEncoder()

/** A `ws.data` payload. Bun never hands the host a `SharedArrayBuffer`, so every `SocketData` is one. */
type Payload = string | Uint8Array<ArrayBuffer>

type ChannelFrame = Extract<ServerFrame, { type: 'ws.open' | 'ws.data' | 'ws.close' | 'ws.ack' }>

/** One open channel. Byte counts are `ws.data` payload bytes. */
interface Channel {
  id: number
  path: string
  headers: [string, string][]
  /** Null until the channel's auth message has been accepted. */
  principal: Principal | null
  /** Runs out when no auth message arrives in time. Cleared once one does. */
  authTimer: Timer | undefined
  /** Null until the handler has returned it. */
  session: SocketSession | null
  open: boolean
  /** Bytes sent to the server that it has not acked yet. */
  unacked: number
  /** Messages waiting for window, oldest first. */
  queue: Payload[]
  queuedBytes: number
  /** Bytes delivered to the handler that the host has not acked yet. */
  owed: number
}

/**
 * The tunneled WebSockets of one tunnel connection, keyed by channel id. Each
 * `ws.open` becomes a `SocketConn` for `openSocket`. Both directions follow the
 * `WS_CHANNEL_WINDOW_BYTES` window: messages past it wait in the channel's
 * queue, and delivered messages are acked once per tick. After `close()` it
 * writes nothing more.
 *
 * No handler runs before the channel's first message, which must be a
 * `socketAuthMessage` whose key `authorize` accepts. Anything else, or nothing
 * within the auth timeout, gets `auth.failed` and a `CLOSE_ACCESS_DENIED` close.
 */
export class TunnelChannels {
  private readonly channels = new Map<number, Channel>()
  private readonly owing = new Set<Channel>()
  private ackScheduled = false
  private closed = false

  private readonly queueCapBytes: number
  private readonly authTimeoutMs: number

  constructor(
    private readonly openSocket: OpenSocket,
    private readonly authorize: Authorize,
    private readonly send: (frame: MachineFrame) => void,
    options: { queueCapBytes?: number; authTimeoutMs?: number } = {},
  ) {
    this.queueCapBytes = options.queueCapBytes ?? CHANNEL_QUEUE_CAP_BYTES
    this.authTimeoutMs = options.authTimeoutMs ?? AUTH_TIMEOUT_MS
  }

  /** Takes a `ws.*` frame from the server. Frames for unknown or closed channels are ignored. */
  receive(frame: ChannelFrame): void {
    if (this.closed) return
    if (frame.type === 'ws.open') {
      this.open(frame.channel, frame.path, frame.headers)
      return
    }
    const channel = this.channels.get(frame.channel)
    if (!channel) return
    if (frame.type === 'ws.data') this.deliver(channel, frame.data)
    else if (frame.type === 'ws.ack') this.acked(channel, frame.bytes)
    else this.end(channel)
  }

  /** Ends every channel, for a tunnel that went away. Nothing is sent. */
  close(): void {
    this.closed = true
    const channels = [...this.channels.values()]
    this.channels.clear()
    this.owing.clear()
    for (const channel of channels) this.end(channel)
  }

  /** Closes every channel authorized by one of `keyIds` with `CLOSE_ACCESS_DENIED`, for a rotated key. */
  closeChannels(keyIds: Iterable<string>): void {
    const revoked = new Set(keyIds)
    for (const channel of [...this.channels.values()]) {
      if (channel.principal && revoked.has(channel.principal.keyId)) {
        this.fail(channel, CLOSE_ACCESS_DENIED, 'key rotated')
      }
    }
  }

  /** The number of open channels. */
  get size(): number {
    return this.channels.size
  }

  private open(id: number, path: string, headers: [string, string][]) {
    if (this.channels.has(id)) return
    const channel: Channel = {
      id,
      path,
      headers,
      principal: null,
      authTimer: undefined,
      session: null,
      open: true,
      unacked: 0,
      queue: [],
      queuedBytes: 0,
      owed: 0,
    }
    this.channels.set(id, channel)
    channel.authTimer = setTimeout(() => this.deny(channel, 'auth timeout'), this.authTimeoutMs)
  }

  /** Reads a channel's first message as its auth message, then opens its socket or refuses it. */
  private authenticate(channel: Channel, data: SocketData) {
    clearTimeout(channel.authTimer)
    channel.authTimer = undefined
    const message = parseMessage(socketAuthMessage, data)
    const principal = message ? this.authorize(message.key) : null
    if (!principal) {
      this.deny(channel, 'access denied')
      return
    }
    channel.principal = principal
    this.start(channel, principal)
  }

  /** Refuses a channel's key: `auth.failed` first, while the server still knows its browser, then the close. */
  private deny(channel: Channel, reason: string) {
    if (!channel.open || this.closed) return
    this.send({ type: 'auth.failed', channel: channel.id })
    this.fail(channel, CLOSE_ACCESS_DENIED, reason)
  }

  private start(channel: Channel, principal: Principal) {
    const { id, path, headers } = channel
    const conn: SocketConn = {
      send: (data) => this.write(channel, data),
      buffered: () => (channel.open ? channel.unacked + channel.queuedBytes : 0),
      close: (code, reason) => this.fail(channel, code, reason),
    }
    let result: SocketSession | SocketRefusal
    try {
      // A handler may send while it opens, as a terminal sends its snapshot; the channel is registered already.
      result = this.openSocket(path, headers, conn, principal)
    } catch (error) {
      console.error(`tunneled socket ${id} failed to open`, error)
      this.fail(channel, CLOSE_INTERNAL_ERROR, 'internal error')
      return
    }
    if ('code' in result) {
      this.remove(channel)
      this.send({ type: 'ws.close', channel: id, code: result.code, reason: result.reason })
      return
    }
    channel.session = result
    // The handler closed its connection while opening, so it learns now, as it would from a local socket.
    if (!channel.open) result.close()
  }

  private deliver(channel: Channel, data: SocketData) {
    try {
      if (channel.principal) channel.session?.message(data)
      else this.authenticate(channel, data)
    } catch (error) {
      // A local socket's handler error ends at Bun's socket; here it must not reach the tunnel's own listener.
      console.error(`tunneled socket ${channel.id} failed on a message`, error)
      this.fail(channel, CLOSE_INTERNAL_ERROR, 'internal error')
    }
    if (!channel.open) return
    channel.owed += wsPayloadBytes(data)
    this.owing.add(channel)
    if (this.ackScheduled) return
    this.ackScheduled = true
    // Acks for the messages of one tick are merged into one `ws.ack` per channel.
    queueMicrotask(() => {
      this.ackScheduled = false
      if (this.closed) return
      for (const owing of this.owing) {
        if (owing.open && owing.owed > 0) this.send({ type: 'ws.ack', channel: owing.id, bytes: owing.owed })
        owing.owed = 0
      }
      this.owing.clear()
    })
  }

  private acked(channel: Channel, bytes: number) {
    channel.unacked = Math.max(0, channel.unacked - bytes)
    while (channel.open && channel.unacked < WS_CHANNEL_WINDOW_BYTES) {
      const data = channel.queue.shift()
      if (data === undefined) return
      const size = wsPayloadBytes(data)
      channel.queuedBytes -= size
      channel.unacked += size
      this.send({ type: 'ws.data', channel: channel.id, data })
    }
  }

  /** `SocketConn.send` for a channel, with Bun's return meaning. */
  private write(channel: Channel, message: SocketData): number {
    if (!channel.open || this.closed) return 0
    const data = message as Payload
    if (!fitsInFrame(channel.id, data)) {
      // Only the size is logged: the message may be terminal output.
      console.warn(
        `closing tunneled socket ${channel.id}: a ${wsPayloadBytes(data)}-byte message does not fit in a frame`,
      )
      this.fail(channel, CLOSE_TOO_BIG, 'message too big')
      return 0
    }
    const size = wsPayloadBytes(data)
    if (channel.queue.length === 0 && channel.unacked < WS_CHANNEL_WINDOW_BYTES) {
      channel.unacked += size
      this.send({ type: 'ws.data', channel: channel.id, data })
      return size
    }
    if (channel.queuedBytes + size > this.queueCapBytes) {
      console.warn(`closing tunneled socket ${channel.id}: its client stopped taking messages`)
      this.fail(channel, CLOSE_INTERNAL_ERROR, 'too far behind')
      return 0
    }
    // The caller may reuse its buffer, so a queued message keeps a copy.
    channel.queue.push(typeof data === 'string' ? data : data.slice())
    channel.queuedBytes += size
    return -1
  }

  /** Closes a channel from the host's side: tells the server, then the handler. */
  private fail(channel: Channel, code?: number, reason?: string) {
    if (!channel.open) return
    this.remove(channel)
    if (!this.closed) {
      this.send({
        type: 'ws.close',
        channel: channel.id,
        ...(code !== undefined ? { code } : {}),
        ...(reason ? { reason } : {}),
      })
    }
    channel.session?.close()
  }

  /** Ends a channel the other side closed. */
  private end(channel: Channel) {
    if (!channel.open) return
    this.remove(channel)
    channel.session?.close()
  }

  private remove(channel: Channel) {
    channel.open = false
    clearTimeout(channel.authTimer)
    channel.authTimer = undefined
    channel.queue.length = 0
    channel.queuedBytes = 0
    channel.owed = 0
    if (this.channels.get(channel.id) === channel) this.channels.delete(channel.id)
    this.owing.delete(channel)
  }
}

/** True when a `ws.data` frame carrying `data` fits in one tunnel frame. Short payloads are not measured. */
function fitsInFrame(channel: number, data: Payload): boolean {
  const bound = typeof data === 'string' ? data.length * MAX_ESCAPE_BYTES : data.byteLength
  if (bound + FRAME_OVERHEAD_BYTES <= MAX_TUNNEL_FRAME_BYTES) return true
  const encoded = encodeFrame({ type: 'ws.data', channel, data })
  return (
    (typeof encoded === 'string' ? encoder.encode(encoded).byteLength : encoded.byteLength) <= MAX_TUNNEL_FRAME_BYTES
  )
}
