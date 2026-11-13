import {
  CLOSE_E2E_SESSION_UNKNOWN,
  decodeSocketMessageRecord,
  type E2eChannel,
  type E2eSocketMessage,
  encodeSocketMessageRecord,
} from '@orch/shared'

/** What a sealed socket needs: where to connect, the envelope to send first, and the channel it sealed it on. */
export interface SealedSocketOptions {
  /** The server's sealed socket route for the machine, `machineSealedSocketPath` on the server's origin. */
  url: string
  /** The envelope: the session id, the channel number and the open record sealed on `channel`. */
  envelope: Uint8Array<ArrayBuffer>
  channel: E2eChannel
  /** Called when the machine closes with `CLOSE_E2E_SESSION_UNKNOWN`, so the transport drops its session. */
  onSessionUnknown?: () => void
}

// The close code the page gets for a relay that tampered with the socket, as for a dropped connection.
const CLOSE_ABNORMAL = 1006
// The close code the page gets for a message too large to seal, as the server gives a plain socket.
const CLOSE_TOO_BIG = 1009

/**
 * A `WebSocket` whose messages are sealed end to end on one channel of a
 * session. It opens a real socket with no subprotocols and sends the envelope
 * as its first message, and only then reports `open`. `send` seals each
 * message in call order, and each incoming record is opened in arrival order
 * before the page sees it: text as a string, binary as an `ArrayBuffer` or a
 * `Blob`, following `binaryType`. Text from the relay, or a record that
 * doesn't open, comes out of order or isn't a message, ends it at once with
 * 1006 and closes the real socket, so the page never sees a forged or
 * reordered message. Otherwise the real socket's close code reaches the page
 * as it is. It covers what `PendingSocket` uses: `url`, `readyState`,
 * `binaryType`, the `on*` handlers, `send` and `close`.
 */
class SealedSocket {
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  binaryType: BinaryType = 'blob'
  private state: number = WebSocket.CONNECTING
  private readonly real: WebSocket
  private readonly channel: E2eChannel
  /** Settles once every record received so far is opened and delivered, in order. */
  private incoming: Promise<void> = Promise.resolve()
  /** Settles once every message sent so far is sealed and handed to the real socket, in order. */
  private outgoing: Promise<void> = Promise.resolve()

  constructor(
    readonly url: string,
    options: SealedSocketOptions,
  ) {
    this.channel = options.channel
    const real = new WebSocket(url)
    this.real = real
    real.binaryType = 'arraybuffer'
    real.onopen = () => {
      if (this.state !== WebSocket.CONNECTING) return
      real.send(options.envelope)
      this.state = WebSocket.OPEN
      this.onopen?.(new Event('open'))
    }
    real.onmessage = (event) => this.received(event.data)
    real.onerror = (event) => {
      if (this.state !== WebSocket.CLOSED) this.onerror?.(event)
    }
    real.onclose = (event) => {
      if (event.code === CLOSE_E2E_SESSION_UNKNOWN) options.onSessionUnknown?.()
      // Messages already received are delivered before the close.
      this.incoming = this.incoming.then(() => this.ended(event.code, event.reason, event.wasClean))
    }
  }

  get readyState(): number {
    return this.state
  }

  /** The real socket's buffered bytes, which count the sealed size. */
  get bufferedAmount(): number {
    return this.real.bufferedAmount
  }

  get protocol(): string {
    return ''
  }

  get extensions(): string {
    return ''
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.state === WebSocket.CONNECTING) {
      throw new DOMException('The socket is still connecting.', 'InvalidStateError')
    }
    if (this.state !== WebSocket.OPEN) return
    let record: Uint8Array
    try {
      record = encodeSocketMessageRecord(messageOf(data))
    } catch {
      this.fail(CLOSE_TOO_BIG)
      return
    }
    const { channel, real } = this
    this.outgoing = this.outgoing.then(async () => {
      const sealed = await channel.seal(record).catch(() => null)
      if (!sealed) return this.fail(CLOSE_ABNORMAL)
      if (this.state === WebSocket.OPEN && real.readyState === WebSocket.OPEN) real.send(new Uint8Array(sealed))
    })
  }

  close(code?: number, reason?: string): void {
    if (this.state === WebSocket.CLOSING || this.state === WebSocket.CLOSED) return
    this.state = WebSocket.CLOSING
    this.real.close(code, reason)
  }

  private received(data: unknown) {
    if (this.state === WebSocket.CLOSED) return
    if (!(data instanceof ArrayBuffer)) {
      this.fail(CLOSE_ABNORMAL)
      return
    }
    const sealed = new Uint8Array(data)
    this.incoming = this.incoming.then(async () => {
      if (this.state === WebSocket.CLOSED) return
      let message: E2eSocketMessage
      try {
        message = decodeSocketMessageRecord(await this.channel.open(sealed))
      } catch {
        return this.fail(CLOSE_ABNORMAL)
      }
      if (this.state === WebSocket.CLOSED) return
      this.onmessage?.(new MessageEvent('message', { data: this.delivered(message) }))
    })
  }

  /** A message as the page reads it: a string, or bytes as `binaryType` asks. */
  private delivered(message: E2eSocketMessage): string | ArrayBuffer | Blob {
    if (typeof message === 'string') return message
    const bytes = message.slice()
    return this.binaryType === 'arraybuffer' ? bytes.buffer : new Blob([bytes])
  }

  /** Ends the socket for the page with `code` at once, and closes the real one. */
  private fail(code: number) {
    if (this.state === WebSocket.CLOSED) return
    this.real.close()
    this.ended(code, '', false)
  }

  private ended(code: number, reason: string, wasClean: boolean) {
    if (this.state === WebSocket.CLOSED) return
    this.state = WebSocket.CLOSED
    this.onclose?.(new CloseEvent('close', { code, reason, wasClean }))
  }
}

/** The page's message as a record carries it: text as a string, anything else as its bytes. */
function messageOf(data: string | ArrayBuffer | ArrayBufferView): E2eSocketMessage {
  if (typeof data === 'string') return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}

/** A socket sealed end to end; see `SealedSocket`. */
export function sealedSocket(options: SealedSocketOptions): WebSocket {
  return new SealedSocket(options.url, options) as unknown as WebSocket
}
