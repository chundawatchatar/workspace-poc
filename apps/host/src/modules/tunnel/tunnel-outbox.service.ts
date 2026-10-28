import { type FrameLane, FrameScheduler, type MachineFrame } from '@orch/shared'

/** Response bodies are read only while the bulk lane holds less than this many bytes. */
export const BULK_CAP_BYTES = 1024 * 1024

/** How often queued frames are retried, in milliseconds. A client WebSocket has no drain event. */
export const REFLUSH_MS = 10

/**
 * The host's lanes: HTTP responses in bulk, in one lane so each response stays
 * in order, and everything else (`hello`, heartbeats, `ws.*`) interactive.
 */
export function hostLane(frame: MachineFrame): FrameLane {
  return frame.type === 'http.response' || frame.type === 'http.body' || frame.type === 'http.end'
    ? 'bulk'
    : 'interactive'
}

/** What the outbox needs from the tunnel socket. */
export interface TunnelOutboxDeps {
  write(data: string | Uint8Array<ArrayBuffer>): void
  bufferedAmount(): number
  highWaterMark?: number
  bulkCapBytes?: number
  reflushMs?: number
}

/**
 * Everything one tunnel connection sends, through a two-lane `FrameScheduler`.
 * While frames are queued it retries on a short timer, and `room()` holds
 * response bodies back while the bulk lane is full. After `close()` it writes
 * nothing more.
 */
export class TunnelOutbox {
  private readonly scheduler: FrameScheduler<MachineFrame>
  private readonly bulkCapBytes: number
  private readonly reflushMs: number
  private timer: Timer | undefined
  private waiters: (() => void)[] = []
  private closed = false

  constructor({
    write,
    bufferedAmount,
    highWaterMark,
    bulkCapBytes = BULK_CAP_BYTES,
    reflushMs = REFLUSH_MS,
  }: TunnelOutboxDeps) {
    this.scheduler = new FrameScheduler({ write, bufferedAmount, highWaterMark, lane: hostLane })
    this.bulkCapBytes = bulkCapBytes
    this.reflushMs = reflushMs
  }

  /** Queues a frame and writes what the socket has room for. */
  send(frame: MachineFrame): void {
    if (this.closed) return
    this.scheduler.send(frame)
    this.settle()
  }

  /** Resolves once the bulk lane holds less than the cap, or the outbox is closed. */
  room(): Promise<void> {
    if (this.closed || this.scheduler.bulkBytes < this.bulkCapBytes) return Promise.resolve()
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  /** The encoded bytes waiting in the bulk lane. */
  get bulkBytes(): number {
    return this.scheduler.bulkBytes
  }

  /** Drops every queued frame, stops the timer and lets every waiting body reader go. */
  close(): void {
    this.closed = true
    this.scheduler.clear()
    clearInterval(this.timer)
    this.timer = undefined
    this.wake()
  }

  /** Wakes body readers when there is room, and keeps the timer running exactly while frames are queued. */
  private settle() {
    if (this.scheduler.bulkBytes < this.bulkCapBytes) this.wake()
    if (this.scheduler.queued === 0) {
      clearInterval(this.timer)
      this.timer = undefined
    } else if (!this.timer) {
      this.timer = setInterval(() => {
        this.scheduler.flush()
        this.settle()
      }, this.reflushMs)
    }
  }

  private wake() {
    const waiters = this.waiters
    this.waiters = []
    for (const resolve of waiters) resolve()
  }
}
