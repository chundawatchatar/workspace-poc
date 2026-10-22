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
  /** The daemon answers terminal colour queries itself, so the browser stays quiet. */
  colors: z.boolean().optional(),
})

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

/** Decodes bounded frames across arbitrary socket chunk boundaries. */
export class DaemonDecoder {
  private pending = Buffer.alloc(0)

  push(chunk: Buffer): DaemonFrame[] {
    this.pending = Buffer.concat([this.pending, chunk])
    const frames: DaemonFrame[] = []
    while (this.pending.length >= 5) {
      const kind = this.pending.readUInt8(0)
      const length = this.pending.readUInt32BE(1)
      if (length === 0 || length > MAX_FRAME) throw new Error('Invalid terminal daemon frame length')
      if (this.pending.length < length + 5) break
      const payload = this.pending.subarray(5, 5 + length)
      this.pending = this.pending.subarray(5 + length)
      if (kind === OUTPUT) frames.push({ kind: 'output', bytes: payload })
      else if (kind === CONTROL) frames.push({ kind: 'control', value: JSON.parse(payload.toString()) })
      else throw new Error('Invalid terminal daemon frame kind')
    }
    return frames
  }
}
