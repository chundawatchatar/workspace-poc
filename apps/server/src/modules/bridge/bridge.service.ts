import {
  CLOSE_MACHINE_OFFLINE,
  MAX_TUNNEL_FRAME_BYTES,
  type MachineFrame,
  WS_CHANNEL_WINDOW_BYTES,
  wsPayloadBytes,
} from '@orch/shared'
import { frameBytes } from '../../lib/relay'
import type { MachineConnection, MachineRegistry } from '../tunnel/tunnel.service'

/** Close code for a message that does not fit in one tunnel frame. */
export const CLOSE_TOO_BIG = 1009
/** Close code for a machine that already has `maxChannelsPerMachine` open channels. */
export const CLOSE_TRY_AGAIN_LATER = 1013
/** Close code for a browser that sent more than the window while the machine was not acking. */
export const CLOSE_POLICY = 1008
/** Close code for a machine that sent past its window. */
export const CLOSE_INTERNAL_ERROR = 1011

// A close reason must fit in a close frame's 123 bytes.
const MAX_CLOSE_REASON_BYTES = 123
// The most `ws.data` overhead a string payload can need: JSON escapes take at
// most 6 bytes per UTF-16 unit, plus the frame's other fields.
const MAX_ESCAPE_BYTES = 6
const FRAME_OVERHEAD_BYTES = 64

/** A browser message: a string is a text message and bytes a binary one. */
type BrowserData = string | Uint8Array<ArrayBuffer>

/** The browser end of a channel. */
export interface BrowserSocket {
  /** Hands a message to the socket. False means the socket is backpressured, and `drained` follows. */
  send(data: string | Uint8Array): boolean
  close(code: number, reason: string): void
}

/** What the browser socket's binding calls on the channel it opened. */
export interface BrowserChannel {
  /** A message from the browser. */
  message(data: BrowserData): void
  /** The browser socket closed, with the code and reason it reported. */
  closed(code: number, reason: string): void
  /** The browser socket can take more data. */
  drained(): void
}

/** What the bridge needs from the server. */
export interface ChannelBridgeDeps {
  registry: MachineRegistry
  /** The most channels one machine may have open. Defaults to 128. */
  maxChannelsPerMachine?: number
}

/** One open channel. Byte counts are `ws.data` payload bytes. */
interface Channel {
  id: number
  socket: BrowserSocket
  /** Bytes sent to the machine that it has not acked yet. */
  unacked: number
  /** Browser messages waiting for window, oldest first. */
  queue: BrowserData[]
  queuedBytes: number
  /** Bytes the machine sent that the server has not acked yet. */
  inbound: number
  /** Bytes handed to a backpressured browser socket, acked once it drains. */
  heldAck: number
  /** True between a backpressured send and the socket's drain. */
  backpressured: boolean
  /** The IP of the browser that opened the channel. */
  clientIp: string
  /** True once the machine reported the channel's key as refused. */
  authFailed: boolean
}

/** The open channels on one tunnel. It lives until the tunnel closes, so channel ids are never reused. */
interface ConnectionState {
  nextId: number
  channels: Map<number, Channel>
}

/**
 * Bridges browser WebSockets to channels on their machine's tunnel. It routes
 * on the frame envelope only (connection, channel id, sizes) and never reads
 * the path, headers or messages it relays. Each direction is flow-controlled
 * with a `WS_CHANNEL_WINDOW_BYTES` window of unacknowledged payload bytes.
 */
export class ChannelBridge {
  private readonly registry: MachineRegistry
  private readonly maxChannelsPerMachine: number
  private readonly connections = new Map<MachineConnection, ConnectionState>()
  // Tunnels that already closed. One may still sit in the registry until its close event arrives.
  private readonly closed = new WeakSet<MachineConnection>()

  constructor({ registry, maxChannelsPerMachine = 128 }: ChannelBridgeDeps) {
    this.registry = registry
    this.maxChannelsPerMachine = maxChannelsPerMachine
  }

  /**
   * Opens a channel to the machine for a browser socket and sends its
   * `ws.open`. Returns null after closing the socket when the machine is offline
   * (`CLOSE_MACHINE_OFFLINE`) or has too many channels (1013). `clientIp` is
   * kept with the channel, for `authFailed`.
   */
  open(
    machineId: string,
    path: string,
    headers: [string, string][],
    socket: BrowserSocket,
    clientIp = '',
  ): BrowserChannel | null {
    const conn = this.registry.get(machineId)
    if (!conn || this.closed.has(conn)) {
      socket.close(CLOSE_MACHINE_OFFLINE, 'machine offline')
      return null
    }
    const state = this.stateOf(conn)
    if (state.channels.size >= this.maxChannelsPerMachine) {
      socket.close(CLOSE_TRY_AGAIN_LATER, 'too many channels')
      return null
    }
    const channel: Channel = {
      id: state.nextId++,
      socket,
      unacked: 0,
      queue: [],
      queuedBytes: 0,
      inbound: 0,
      heldAck: 0,
      backpressured: false,
      clientIp,
      authFailed: false,
    }
    state.channels.set(channel.id, channel)
    conn.send({ type: 'ws.open', channel: channel.id, path, headers })
    return {
      message: (data) => this.fromBrowser(conn, channel, data),
      closed: (code, reason) => this.browserClosed(conn, channel, code, reason),
      drained: () => this.drained(conn, channel),
    }
  }

  /** Takes a `ws.data`, `ws.close` or `ws.ack` from `conn`. Frames for unknown or closed channels are ignored. */
  handleFrame(conn: MachineConnection, frame: MachineFrame): void {
    if (frame.type !== 'ws.data' && frame.type !== 'ws.close' && frame.type !== 'ws.ack') return
    const channel = this.connections.get(conn)?.channels.get(frame.channel)
    if (!channel) return

    if (frame.type === 'ws.data') {
      if (channel.inbound >= WS_CHANNEL_WINDOW_BYTES) {
        this.fail(conn, channel, CLOSE_INTERNAL_ERROR, 'window exceeded')
        return
      }
      const bytes = wsPayloadBytes(frame.data)
      channel.inbound += bytes
      const ready = channel.socket.send(frame.data)
      if (!ready) channel.backpressured = true
      if (channel.backpressured) channel.heldAck += bytes
      else this.ack(conn, channel, bytes)
    } else if (frame.type === 'ws.ack') {
      channel.unacked = Math.max(0, channel.unacked - frame.bytes)
      this.pump(conn, channel)
    } else {
      this.remove(conn, channel)
      channel.socket.close(closeCode(frame.code), closeReason(frame.reason))
    }
  }

  /** Closes every browser socket on `conn` with `CLOSE_MACHINE_OFFLINE`. */
  connectionClosed(conn: MachineConnection): void {
    this.closed.add(conn)
    const state = this.connections.get(conn)
    if (!state) return
    this.connections.delete(conn)
    for (const channel of state.channels.values()) channel.socket.close(CLOSE_MACHINE_OFFLINE, 'machine offline')
  }

  /**
   * Takes the machine's report that `channel` on `conn` had a refused key, and
   * returns the IP of the browser that opened it. Undefined means no such
   * channel is open, or it was already reported, so a machine can count each
   * channel against its browser only once.
   */
  authFailed(conn: MachineConnection, channel: number): string | undefined {
    const entry = this.connections.get(conn)?.channels.get(channel)
    if (!entry || entry.authFailed) return undefined
    entry.authFailed = true
    return entry.clientIp
  }

  /** The number of open channels, across every tunnel. */
  get size(): number {
    let size = 0
    for (const state of this.connections.values()) size += state.channels.size
    return size
  }

  private stateOf(conn: MachineConnection): ConnectionState {
    let state = this.connections.get(conn)
    if (!state) {
      state = { nextId: 1, channels: new Map() }
      this.connections.set(conn, state)
    }
    return state
  }

  private isOpen(conn: MachineConnection, channel: Channel): boolean {
    return this.connections.get(conn)?.channels.get(channel.id) === channel
  }

  private fromBrowser(conn: MachineConnection, channel: Channel, data: BrowserData): void {
    if (!this.isOpen(conn, channel)) return
    if (!fitsInFrame(channel.id, data)) {
      this.fail(conn, channel, CLOSE_TOO_BIG, 'message too big')
      return
    }
    if (channel.queue.length === 0 && channel.unacked < WS_CHANNEL_WINDOW_BYTES) {
      channel.unacked += wsPayloadBytes(data)
      conn.send({ type: 'ws.data', channel: channel.id, data })
      return
    }
    const bytes = wsPayloadBytes(data)
    if (channel.queuedBytes + bytes > WS_CHANNEL_WINDOW_BYTES) {
      this.fail(conn, channel, CLOSE_POLICY, 'window exceeded')
      return
    }
    // The binding may hand over a view into the socket message, so keep a copy.
    channel.queue.push(typeof data === 'string' ? data : data.slice())
    channel.queuedBytes += bytes
  }

  /** Sends queued browser messages while the channel has window. */
  private pump(conn: MachineConnection, channel: Channel): void {
    while (channel.unacked < WS_CHANNEL_WINDOW_BYTES) {
      const data = channel.queue.shift()
      if (data === undefined) return
      const bytes = wsPayloadBytes(data)
      channel.queuedBytes -= bytes
      channel.unacked += bytes
      conn.send({ type: 'ws.data', channel: channel.id, data })
    }
  }

  private drained(conn: MachineConnection, channel: Channel): void {
    if (!this.isOpen(conn, channel)) return
    channel.backpressured = false
    const held = channel.heldAck
    channel.heldAck = 0
    this.ack(conn, channel, held)
  }

  private ack(conn: MachineConnection, channel: Channel, bytes: number): void {
    channel.inbound -= bytes
    if (bytes > 0) conn.send({ type: 'ws.ack', channel: channel.id, bytes })
  }

  private browserClosed(conn: MachineConnection, channel: Channel, code: number, reason: string): void {
    if (!this.isOpen(conn, channel)) return
    // Queued messages are dropped, so a machine that never acks cannot hold the close back.
    this.remove(conn, channel)
    const sent = code !== 1005 && code !== 1006 && code >= 1000 && code <= 4999
    conn.send({
      type: 'ws.close',
      channel: channel.id,
      ...(sent ? { code } : {}),
      ...(sent && reason ? { reason } : {}),
    })
  }

  /** Closes a channel on both ends with a code the server decided. */
  private fail(conn: MachineConnection, channel: Channel, code: number, reason: string): void {
    this.remove(conn, channel)
    conn.send({ type: 'ws.close', channel: channel.id, code, reason })
    channel.socket.close(code, reason)
  }

  private remove(conn: MachineConnection, channel: Channel): void {
    this.connections.get(conn)?.channels.delete(channel.id)
    channel.queue.length = 0
    channel.queuedBytes = 0
  }
}

/** True when a `ws.data` frame carrying `data` fits in one tunnel frame. Short payloads are not measured. */
function fitsInFrame(channel: number, data: BrowserData): boolean {
  const bound = typeof data === 'string' ? data.length * MAX_ESCAPE_BYTES : data.byteLength
  if (bound + FRAME_OVERHEAD_BYTES <= MAX_TUNNEL_FRAME_BYTES) return true
  return frameBytes({ type: 'ws.data', channel, data }) <= MAX_TUNNEL_FRAME_BYTES
}

/** The machine's close code, or 1000 when it gave none or one a close frame cannot carry. */
function closeCode(code: number | undefined): number {
  if (code === undefined) return 1000
  const sendable = (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999)
  return sendable ? code : 1000
}

/** The machine's close reason, or none when it is too long for a close frame. */
function closeReason(reason: string | undefined): string {
  return reason && wsPayloadBytes(reason) <= MAX_CLOSE_REASON_BYTES ? reason : ''
}
