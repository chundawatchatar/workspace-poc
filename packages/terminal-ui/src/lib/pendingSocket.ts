/**
 * What a pending socket waits for: the real socket, or a close code to fail with when it can't be opened, such as
 * `CLOSE_ACCESS_DENIED` for a refused relay ticket. A rejection fails it with 1006, like a dropped connection.
 */
export type OpenLater = () => Promise<WebSocket | number>

/**
 * A `WebSocket` whose real socket can only be created once something async is ready, such as a relay ticket that
 * must go in its subprotocols. `HostTransport.openSocket` answers at once, so this stands in until then. It covers
 * what the page uses: `url`, `readyState`, `binaryType`, the `on*` handlers, `send` and `close`. Like a real socket,
 * `send` throws while it connects, and `close` before it opens ends it with 1006.
 */
class PendingSocket {
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  private inner: WebSocket | null = null
  private ended = false
  private type: BinaryType = 'blob'

  constructor(
    readonly url: string,
    open: OpenLater,
  ) {
    open().then(
      (result) => {
        if (typeof result === 'number') return this.fail(result)
        if (this.ended) {
          result.close()
          return
        }
        this.inner = result
        result.binaryType = this.type
        // The real socket can't open before this runs, so no event is missed.
        result.onopen = (event) => this.onopen?.(event)
        result.onmessage = (event) => this.onmessage?.(event)
        result.onerror = (event) => this.onerror?.(event)
        result.onclose = (event) => this.onclose?.(event)
      },
      () => this.fail(1006),
    )
  }

  get readyState(): number {
    if (this.inner) return this.inner.readyState
    return this.ended ? WebSocket.CLOSED : WebSocket.CONNECTING
  }

  get binaryType(): BinaryType {
    return this.type
  }

  set binaryType(type: BinaryType) {
    this.type = type
    if (this.inner) this.inner.binaryType = type
  }

  send(data: Parameters<WebSocket['send']>[0]): void {
    if (!this.inner) throw new DOMException('The socket is still connecting.', 'InvalidStateError')
    this.inner.send(data)
  }

  close(code?: number, reason?: string): void {
    if (this.inner) {
      this.inner.close(code, reason)
      return
    }
    if (this.ended) return
    // Ended at once, so a socket that arrives later is closed unused; a real socket closed while connecting reports
    // 1006 too, after the call returns.
    this.ended = true
    queueMicrotask(() => this.onclose?.(new CloseEvent('close', { code: 1006, wasClean: false })))
  }

  private fail(code: number) {
    if (this.ended || this.inner) return
    this.ended = true
    this.onclose?.(new CloseEvent('close', { code, wasClean: false }))
  }
}

/** A socket to `url` that opens once `open` answers; see `PendingSocket`. */
export function pendingSocket(url: string, open: OpenLater): WebSocket {
  return new PendingSocket(url, open) as unknown as WebSocket
}
