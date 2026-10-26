import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

/**
 * The terminal daemon wire version: JSON control messages and raw binary frames
 * for terminal output. Keeping output binary means a flood pays neither base64
 * nor JSON on the daemon-to-host hop, matching the browser connection.
 */
export const DAEMON_PROTOCOL = 1

const MAX_FRAME = 16 * 1024 * 1024
/** Frame kinds: JSON control, or a raw terminal-output chunk. */
const CONTROL = 1
const OUTPUT = 2

/** The identity and terminal state supplied by a daemon after authentication. */
export const daemonStatus = z.object({
  protocol: z.number().int(),
  id: z.string(),
  instance: z.string().regex(/^[a-f0-9]{32}$/),
  daemonPid: z.number().int().positive(),
  pid: z.number().int().positive().nullable(),
  alive: z.boolean(),
  title: z.string(),
  attention: z.object({ at: z.number(), message: z.string() }).nullable(),
  progress: z.enum(['busy', 'error']).nullable(),
  cols: z.number().int().min(2).max(500),
  rows: z.number().int().min(2).max(200),
  /** The daemon takes the views' theme, to answer colour queries while no view is attached. */
  colors: z.boolean().optional(),
  /** The daemon accepts `viewing` and `redraw`. Daemons started by an older build drop unknown requests. */
  queries: z.boolean().optional(),
  /** A hash of the daemon's code, from `daemonBuild`. Absent from daemons started by an older build. */
  build: z.string().optional(),
  /** When the daemon process started, in epoch milliseconds. Absent from daemons started by an older build. */
  startedAt: z.number().int().optional(),
})

/**
 * A hash of the code a daemon runs: its entry file and this package's sources.
 * The daemon computes it at startup and the host from the files on disk, so a
 * daemon still running code from before an edit or a branch switch is noticed.
 */
export function daemonBuild(entry: string): string {
  const sources = readdirSync(import.meta.dir)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .sort()
    .map((name) => join(import.meta.dir, name))
  const hash = createHash('sha256')
  for (const file of [entry, ...sources]) hash.update(readFileSync(file))
  return hash.digest('hex').slice(0, 16)
}

/** A validated control message from the persistent terminal. Terminal output travels as binary frames. */
export const daemonMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('snapshot'), data: z.string(), status: daemonStatus }),
  z.object({ type: z.literal('status'), status: daemonStatus }),
  z.object({ type: z.literal('closed') }),
])

/** One decoded daemon frame: a JSON control message, or a raw output chunk. */
export type DaemonFrame = { kind: 'control'; value: unknown } | { kind: 'output'; bytes: Uint8Array }

/** Encodes one JSON control message, prefixed with its kind byte. */
export function encodeControlFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value))
  if (payload.length > MAX_FRAME) throw new Error('Terminal daemon frame is too large')
  const header = Buffer.alloc(5)
  header.writeUInt8(CONTROL, 0)
  header.writeUInt32BE(payload.length, 1)
  return Buffer.concat([header, payload])
}

/** One binary terminal-output frame. */
export function encodeOutputFrame(bytes: Uint8Array): Buffer {
  const header = Buffer.alloc(5)
  header.writeUInt8(OUTPUT, 0)
  header.writeUInt32BE(bytes.byteLength, 1)
  return Buffer.concat([header, bytes])
}

/**
 * Decodes bounded frames across arbitrary socket chunk boundaries. Chunks are
 * kept as a list and joined only once a whole frame has arrived, so a large
 * snapshot costs one copy rather than one per chunk.
 */
export class DaemonDecoder {
  private chunks: Buffer[] = []
  private size = 0

  push(chunk: Buffer): DaemonFrame[] {
    if (chunk.length > 0) {
      this.chunks.push(chunk)
      this.size += chunk.length
    }
    const frames: DaemonFrame[] = []
    while (this.size >= 5) {
      const head = this.first(5)
      const kind = head.readUInt8(0)
      const length = head.readUInt32BE(1)
      if (length === 0 || length > MAX_FRAME) throw new Error('Invalid terminal daemon frame length')
      if (this.size < length + 5) break
      const payload = this.take(length + 5).subarray(5)
      if (kind === OUTPUT) frames.push({ kind: 'output', bytes: payload })
      else if (kind === CONTROL) frames.push({ kind: 'control', value: JSON.parse(payload.toString()) })
      else throw new Error('Invalid terminal daemon frame kind')
    }
    return frames
  }

  /** The first chunk, joined with the following ones if it is shorter than `bytes`. */
  private first(bytes: number): Buffer {
    if (this.chunks[0].length < bytes) this.chunks = [Buffer.concat(this.chunks)]
    return this.chunks[0]
  }

  /** Removes and returns the next `bytes` bytes. */
  private take(bytes: number): Buffer {
    const head = this.first(bytes)
    const rest = head.subarray(bytes)
    if (rest.length > 0) this.chunks[0] = rest
    else this.chunks.shift()
    this.size -= bytes
    return head.subarray(0, bytes)
  }
}
