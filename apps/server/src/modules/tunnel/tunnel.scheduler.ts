import { encodeFrame, type ServerFrame } from '@orch/shared'

type Encoded = string | Uint8Array<ArrayBuffer>

/** What the scheduler needs from the tunnel socket. */
export interface FrameSchedulerDeps {
  /** Hands one encoded frame to the socket. */
  write(data: Encoded): void
  /** The bytes the socket holds that the network has not taken yet. */
  bufferedAmount(): number
  /** Frames are written only while `bufferedAmount` is below this. Defaults to 64 KiB. */
  highWaterMark?: number
}

/**
 * Orders the frames a tunnel sends in two lanes, so keystrokes and terminal
 * output are not stuck behind a large `http.request`. The bulk lane carries
 * `http.request` and the interactive lane everything else. Frames are written
 * whole and in order within a lane, and only while the socket's buffer is
 * below `highWaterMark`; the interactive lane always goes first. Call `flush`
 * when the socket drains.
 */
export class FrameScheduler {
  private readonly interactive: Encoded[] = []
  private readonly bulk: Encoded[] = []
  private readonly write: (data: Encoded) => void
  private readonly bufferedAmount: () => number
  private readonly highWaterMark: number

  constructor({ write, bufferedAmount, highWaterMark = 64 * 1024 }: FrameSchedulerDeps) {
    this.write = write
    this.bufferedAmount = bufferedAmount
    this.highWaterMark = highWaterMark
  }

  /** Queues a frame and writes what the socket has room for. */
  send(frame: ServerFrame): void {
    // Encoding now copies byte payloads, which may be views into a socket message.
    const lane = frame.type === 'http.request' ? this.bulk : this.interactive
    lane.push(encodeFrame(frame))
    this.flush()
  }

  /** Writes queued frames, interactive ones first, until the socket's buffer reaches `highWaterMark`. */
  flush(): void {
    while (this.bufferedAmount() < this.highWaterMark) {
      const next = this.interactive.shift() ?? this.bulk.shift()
      if (next === undefined) return
      this.write(next)
    }
  }

  /** Drops every queued frame, for a tunnel that is closing. */
  clear(): void {
    this.interactive.length = 0
    this.bulk.length = 0
  }

  /** The number of frames waiting for room in the socket. */
  get queued(): number {
    return this.interactive.length + this.bulk.length
  }
}
