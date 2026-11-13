import {
  CLOSE_ACCESS_DENIED,
  CLOSE_DEVICE_NOT_APPROVED,
  type MachineFrame,
  type ServerFrame,
  WS_CHANNEL_WINDOW_BYTES,
  wsPayloadBytes,
} from '@orch/shared'
import type { Principal } from '../../lib/principal'
import type { SocketConn, SocketData, SocketSession } from '../../lib/socket'
import type { SocketRefusal } from '../../lib/socketRouter'
import type { RecordAudit } from '../remote-access/audit-log.service'
import {
  type Authorize,
  authorizeWithReason,
  type Credentials,
  DEVICE_NOT_APPROVED,
  type SealedSessionLookup,
  samePrincipal,
  socketCredentials,
} from './tunnel-http.service'
import { CLOSE_POLICY, openSealedChannel, SealedChannel, sealableRecord, sealedSize } from './tunnel-sealed.service'

/**
 * Opens the socket a `ws.open` asks for, as the principal that authorized it,
 * or says why not. In the host this is the app's `SocketRouter`.
 */
export type OpenSocket = (
  path: string,
  headers: [string, string][],
  conn: SocketConn,
  principal: Principal,
) => SocketSession | SocketRefusal

/** The most payload bytes a channel may queue while it waits for window. Past it, the channel closes with 1011. */
export const CHANNEL_QUEUE_CAP_BYTES = 4 * 1024 * 1024

/** Close code for a message that does not fit in one tunnel frame. */
const CLOSE_TOO_BIG = 1009
/** Close code for a channel whose client stopped taking its messages, or whose handler failed. */
const CLOSE_INTERNAL_ERROR = 1011

/** A `ws.data` payload. Bun never hands the host a `SharedArrayBuffer`, so every `SocketData` is one. */
type Payload = string | Uint8Array<ArrayBuffer>

/** An open, authorized channel as `TunnelChannels.list` shows it. `openedAt` is in milliseconds. */
export interface OpenChannel {
  principal: Principal
  openedAt: number
}

type ChannelFrame = Extract<ServerFrame, { type: 'ws.open' | 'ws.sealed' | 'ws.data' | 'ws.close' | 'ws.ack' }>

/** One open channel. Byte counts are `ws.data` payload bytes. */
interface Channel {
  id: number
  /** Empty until the channel's envelope has opened. */
  path: string
  /** Null until the channel's auth message has been accepted. */
  principal: Principal | null
  /**
   * The channel's session, from when its auth message was accepted: a random
   * id that ties its `opened` and `closed` in the audit log, and when it was,
   * in milliseconds, as `list` shows it. Null until then.
   */
  opened: { session: string; at: number } | null
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
  /** Its payloads' seal, opened from the `ws.sealed` envelope. */
  sealed: SealedChannel
}

/**
 * The tunneled WebSockets of one tunnel connection, keyed by channel id. Each
 * `ws.sealed` becomes a `SocketConn` for `openSocket`. Both directions follow
 * the `WS_CHANNEL_WINDOW_BYTES` window: messages past it wait in the channel's
 * queue, and delivered messages are acked once per tick. After `close()` it
 * writes nothing more.
 *
 * A plain `ws.open` is refused as it arrives: it is recorded as `unsealed` and
 * closed with `CLOSE_ACCESS_DENIED`, with no `auth.failed`, and it is never
 * registered, so its `ws.data` reaches nothing.
 *
 * A `ws.sealed` channel is registered at once and opens from its envelope
 * (`openSealedChannel`, with `sessions`). No handler runs before `authorize`
 * accepts the auth message sealed in it: its key, or with `account: true` the
 * relay ticket sealed beside it, which it spends, either one with the message's
 * `device` proof for `'WS'` and the channel's path. A device that isn't
 * approved gets a `CLOSE_DEVICE_NOT_APPROVED` close and no `auth.failed`; other
 * bad credentials get `auth.failed` and a `CLOSE_ACCESS_DENIED` close. Its
 * principal must have opened the session (`CLOSE_ACCESS_DENIED`, no
 * `auth.failed`). Its handler gets no headers, and its payloads are opened and
 * sealed in order (`SealedChannel`); windows, queues, acks and `buffered()`
 * count sealed bytes.
 *
 * Every refusal is recorded with its reason, and every socket that starts is
 * recorded as `opened`, then `closed` when its channel ends for any reason.
 */
export class TunnelChannels {
  private readonly channels = new Map<number, Channel>()
  private readonly owing = new Set<Channel>()
  private ackScheduled = false
  private closed = false

  private readonly queueCapBytes: number
  private readonly record: RecordAudit
  private readonly now: () => number
  private readonly sessions: SealedSessionLookup

  constructor(
    private readonly openSocket: OpenSocket,
    private readonly authorize: Authorize,
    private readonly send: (frame: MachineFrame) => void,
    options: {
      queueCapBytes?: number
      now?: () => number
      record?: RecordAudit
      /** Finds the session a sealed socket names. Without it, every one gets `CLOSE_E2E_SESSION_UNKNOWN`. */
      sessions?: SealedSessionLookup
    } = {},
  ) {
    this.queueCapBytes = options.queueCapBytes ?? CHANNEL_QUEUE_CAP_BYTES
    this.now = options.now ?? Date.now
    this.record = options.record ?? (() => {})
    this.sessions = options.sessions ?? (() => null)
  }

  /** Takes a `ws.*` frame from the server. Frames for unknown or closed channels are ignored. */
  receive(frame: ChannelFrame): void {
    if (this.closed) return
    if (frame.type === 'ws.open') {
      this.refuseUnsealed(frame.channel)
      return
    }
    if (frame.type === 'ws.sealed') {
      this.openSealed(frame.channel, frame.data)
      return
    }
    const channel = this.channels.get(frame.channel)
    if (!channel) return
    if (frame.type === 'ws.data') this.receiveSealed(channel, channel.sealed, frame.data)
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

  /**
   * Closes every channel whose principal `revoked` matches with `code` and
   * `reason`: `CLOSE_ACCESS_DENIED` for a rotated key, a revoked device or an
   * unlinked account, `CLOSE_SESSION_ENDED` for an account that ended a session.
   */
  closeChannels(revoked: (principal: Principal) => boolean, reason: string, code = CLOSE_ACCESS_DENIED): void {
    for (const channel of [...this.channels.values()]) {
      if (channel.principal && revoked(channel.principal)) this.fail(channel, code, reason)
    }
  }

  /** The open channels whose auth message was accepted, with their principal and when it was. */
  list(): OpenChannel[] {
    const listed: OpenChannel[] = []
    for (const { principal, opened } of this.channels.values()) {
      if (principal && opened) listed.push({ principal, openedAt: opened.at })
    }
    return listed
  }

  /** The number of open channels. */
  get size(): number {
    return this.channels.size
  }

  /**
   * Refuses a plain socket before anything about it is read. A channel id
   * already in use is ignored, as for `ws.sealed`, so a live channel isn't closed.
   */
  private refuseUnsealed(id: number) {
    if (this.channels.has(id)) return
    // Nothing about the socket is recorded: its path and headers stay out of the log.
    this.record({ kind: 'refused', reason: 'unsealed' })
    this.send({ type: 'ws.close', channel: id, code: CLOSE_ACCESS_DENIED, reason: 'end-to-end encryption required' })
  }

  /** Registers a sealed channel at once, so its `ws.data` waits in its inbound chain while the envelope opens. */
  private openSealed(id: number, data: Uint8Array) {
    if (this.channels.has(id)) return
    const sealed = new SealedChannel()
    const channel: Channel = {
      id,
      path: '',
      sealed,
      principal: null,
      opened: null,
      session: null,
      open: true,
      unacked: 0,
      queue: [],
      queuedBytes: 0,
      owed: 0,
    }
    this.channels.set(id, channel)
    // A failure past the open (an `authorize` that throws) closes the channel rather than stalling its queue.
    sealed.inbound = this.admitSealed(channel, sealed, data).catch(() => this.fail(channel, CLOSE_INTERNAL_ERROR))
  }

  private async admitSealed(channel: Channel, sealed: SealedChannel, data: Uint8Array) {
    const opened = await openSealedChannel(data, this.sessions)
    if (!channel.open || this.closed) return
    if (!opened.ok) {
      this.fail(channel, opened.code, opened.reason)
      return
    }
    const { e2e, record, owner } = opened
    sealed.e2e = e2e
    channel.path = record.path
    this.admit(channel, socketCredentials(record.auth, record.path, record.ticket ?? null), owner)
  }

  /**
   * Opens the channel's socket once `authorize` accepts `credentials` and they
   * are `owner`'s, or refuses it.
   */
  private admit(channel: Channel, credentials: Credentials, owner: Principal) {
    const { authorization: principal, refusal } = authorizeWithReason(this.authorize, credentials)
    if (refusal) this.record({ kind: 'refused', ...refusal })
    if (!principal) {
      this.deny(channel, 'access denied')
      return
    }
    if (principal === DEVICE_NOT_APPROVED) {
      this.fail(channel, CLOSE_DEVICE_NOT_APPROVED, 'device not approved')
      return
    }
    // Valid credentials, but not the access that opened the session: not a bad key, so no `auth.failed`.
    if (!samePrincipal(principal, owner)) {
      this.fail(channel, CLOSE_ACCESS_DENIED, 'access denied')
      return
    }
    channel.principal = principal
    channel.opened = { session: crypto.randomUUID(), at: this.now() }
    this.record({ kind: 'opened', session: channel.opened.session, principal })
    this.start(channel, principal)
  }

  /** Refuses a channel: `auth.failed` first, while the server still knows its browser, then the close. */
  private deny(channel: Channel, reason: string) {
    if (!channel.open || this.closed) return
    this.send({ type: 'auth.failed', channel: channel.id })
    this.fail(channel, CLOSE_ACCESS_DENIED, reason)
  }

  private start(channel: Channel, principal: Principal) {
    const { id, path } = channel
    const conn: SocketConn = {
      send: (data) => this.write(channel, data),
      buffered: () => (channel.open ? channel.unacked + channel.queuedBytes + channel.sealed.sealing : 0),
      close: (code, reason) => this.fail(channel, code, reason),
    }
    let result: SocketSession | SocketRefusal
    try {
      // A handler may send while it opens, as a terminal sends its snapshot; the channel is registered already.
      // The browser's headers stay with the relay; only the sealed open is the socket's.
      result = this.openSocket(path, [], conn, principal)
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

  /** Opens a sealed payload after the open and every earlier payload, then hands its message over. */
  private receiveSealed(channel: Channel, sealed: SealedChannel, data: SocketData) {
    const live = () => channel.open && !this.closed
    const fail = () => this.fail(channel, CLOSE_POLICY, 'bad message')
    sealed.receive(data, live, (message, bytes) => this.handOver(channel, message, bytes), fail)
    // The server's window bounds this; a server past it is cut off rather than buffered for.
    if (sealed.inboundBytes > this.queueCapBytes) this.fail(channel, CLOSE_POLICY, 'window exceeded')
  }

  /** Hands a message to the channel's handler and owes the server an ack for `bytes`. */
  private handOver(channel: Channel, data: SocketData, bytes: number) {
    try {
      channel.session?.message(data)
    } catch (error) {
      // A local socket's handler error ends at Bun's socket; here it must not reach the tunnel's own listener.
      console.error(`tunneled socket ${channel.id} failed on a message`, error)
      this.fail(channel, CLOSE_INTERNAL_ERROR, 'internal error')
    }
    if (!channel.open) return
    channel.owed += bytes
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
    return this.writeSealed(channel, channel.sealed, message)
  }

  /**
   * `SocketConn.send` for a sealed channel. The message is sealed after every
   * earlier one and sent or queued in that order once sealed, so its size and
   * the result are known at once: the sealed size, or -1 when it will queue.
   */
  private writeSealed(channel: Channel, sealed: SealedChannel, message: SocketData): number {
    const record = sealableRecord(message)
    if (!record) return this.tooBig(channel, wsPayloadBytes(message))
    const size = sealedSize(record)
    // Messages still being sealed go out ahead of this one, so they count as sent already.
    const now = channel.queue.length === 0 && channel.unacked + sealed.sealing < WS_CHANNEL_WINDOW_BYTES
    if (!now && !this.mayQueue(channel, sealed.sealing + size)) return 0
    const live = () => channel.open && !this.closed
    const fail = () => this.fail(channel, CLOSE_INTERNAL_ERROR, 'internal error')
    sealed.seal(record, live, (out) => this.sendOrQueue(channel, out), fail)
    return now ? size : -1
  }

  /** Closes a channel whose message of `bytes` does not fit in one frame. */
  private tooBig(channel: Channel, bytes: number): number {
    // Only the size is logged: the message may be terminal output.
    console.warn(`closing tunneled socket ${channel.id}: a ${bytes}-byte message does not fit in a frame`)
    this.fail(channel, CLOSE_TOO_BIG, 'message too big')
    return 0
  }

  private hasWindow(channel: Channel): boolean {
    return channel.queue.length === 0 && channel.unacked < WS_CHANNEL_WINDOW_BYTES
  }

  /** True when `bytes` more fit in the channel's queue; otherwise the channel is closed. */
  private mayQueue(channel: Channel, bytes: number): boolean {
    if (channel.queuedBytes + bytes <= this.queueCapBytes) return true
    console.warn(`closing tunneled socket ${channel.id}: its client stopped taking messages`)
    this.fail(channel, CLOSE_INTERNAL_ERROR, 'too far behind')
    return false
  }

  /** Sends `data` while the channel has window, else queues a copy, since the caller may reuse its buffer. */
  private sendOrQueue(channel: Channel, data: Payload): number {
    const size = wsPayloadBytes(data)
    if (this.hasWindow(channel)) {
      channel.unacked += size
      this.send({ type: 'ws.data', channel: channel.id, data })
      return size
    }
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

  /** Marks a channel closed and drops it. Every way a channel ends comes through here, so its socket's close is recorded once. */
  private remove(channel: Channel) {
    if (channel.open && channel.opened) this.record({ kind: 'closed', session: channel.opened.session })
    channel.open = false
    channel.queue.length = 0
    channel.queuedBytes = 0
    channel.owed = 0
    if (this.channels.get(channel.id) === channel) this.channels.delete(channel.id)
    this.owing.delete(channel)
  }
}
