import { encodeFrame, type TunnelFrame, wsPayloadBytes } from './contracts/tunnel'

type Encoded = string | Uint8Array<ArrayBuffer>

/** Which queue a frame waits in. The interactive lane always goes first. */
export type FrameLane = 'interactive' | 'bulk'

/** What the scheduler needs from the tunnel socket. */
export interface FrameSchedulerDeps<F extends TunnelFrame> {
  /** Hands one encoded frame to the socket. */
  write(data: Encoded): void
  /** The bytes the socket holds that the network has not taken yet. */
  bufferedAmount(): number
  /** Picks the lane for each frame. */
  lane(frame: F): FrameLane
  /** Frames are written only while `bufferedAmount` is below this. Defaults to 64 KiB. */
  highWaterMark?: number
}

/**
 * Orders the frames one end of a tunnel sends in two lanes, so keystrokes and
 * terminal output are not stuck behind large HTTP traffic. Frames are written
 * whole and in order within a lane, and only while the socket's buffer is
 * below `highWaterMark`; the interactive lane always goes first. Call `flush`
 * when the socket drains.
 */
export class FrameScheduler<F extends TunnelFrame> {
  private readonly interactive: Encoded[] = []
  private readonly bulk: Encoded[] = []
  private bulkQueued = 0
  private readonly write: (data: Encoded) => void
  private readonly bufferedAmount: () => number
  private readonly lane: (frame: F) => FrameLane
  private readonly highWaterMark: number

  constructor({ write, bufferedAmount, lane, highWaterMark = 64 * 1024 }: FrameSchedulerDeps<F>) {
    this.write = write
    this.bufferedAmount = bufferedAmount
    this.lane = lane
    this.highWaterMark = highWaterMark
  }

  /** Queues a frame and writes what the socket has room for. */
  send(frame: F): void {
    // Encoding now copies byte payloads, which may be views into a socket message.
    const encoded = encodeFrame(frame)
    if (this.lane(frame) === 'bulk') {
      this.bulk.push(encoded)
      this.bulkQueued += sizeOf(encoded)
    } else {
      this.interactive.push(encoded)
    }
    this.flush()
  }

  /** Writes queued frames, interactive ones first, until the socket's buffer reaches `highWaterMark`. */
  flush(): void {
    while (this.bufferedAmount() < this.highWaterMark) {
      let next = this.interactive.shift()
      if (next === undefined) {
        next = this.bulk.shift()
        if (next === undefined) return
        this.bulkQueued -= sizeOf(next)
      }
      this.write(next)
    }
  }

  /** Drops every queued frame, for a tunnel that is closing. */
  clear(): void {
    this.interactive.length = 0
    this.bulk.length = 0
    this.bulkQueued = 0
  }

  /** The number of frames waiting for room in the socket. */
  get queued(): number {
    return this.interactive.length + this.bulk.length
  }

  /** The encoded bytes waiting in the bulk lane. */
  get bulkBytes(): number {
    return this.bulkQueued
  }
}

function sizeOf(encoded: Encoded): number {
  return typeof encoded === 'string' ? wsPayloadBytes(encoded) : encoded.byteLength
}
