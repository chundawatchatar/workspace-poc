import { agentTracking, type DaemonDecoder, type TerminalCore } from '@orch/terminal'
import { z } from 'zod'

/** The host-to-daemon messages. Every session request is bound to the connection that attached it. */
export const request = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    protocol: z.number().int(),
    id: z.string().min(1),
    token: z.string(),
    cwd: z.string().default(''),
    cols: z.coerce.number().int().positive().default(80),
    rows: z.coerce.number().int().positive().default(24),
    /** False when the host only wants to close the session: a missing one is answered `closed`, not started. */
    create: z.boolean().default(true),
    /** Whether a browser view is attached through this connection; one that is answers terminal queries. */
    viewing: z.boolean().default(false),
    /** Which agents this session may track. Absent means none, and leaves a session that exists unchanged. */
    tracking: agentTracking.optional(),
  }),
  z.object({ type: z.literal('input'), data: z.string().max(64 * 1024) }),
  z.object({ type: z.literal('resize'), cols: z.number().int(), rows: z.number().int() }),
  z.object({ type: z.literal('clear') }),
  z.object({ type: z.literal('ack') }),
  z.object({ type: z.literal('colors') }).passthrough(),
  z.object({ type: z.literal('close') }),
  z.object({ type: z.literal('snapshot') }),
  z.object({ type: z.literal('viewing'), on: z.boolean() }),
  /** Asks a full-screen program to repaint itself for a view that just attached. */
  z.object({ type: z.literal('redraw') }),
  /** The shell is back at its prompt, so progress its last program left behind is cleared. */
  z.object({ type: z.literal('idle') }),
  /** Which agents this session may track. Turning all of them off ends its token at once. */
  z.object({ type: z.literal('tracking'), ...agentTracking.shape }),
  /** The agent run ended (process inspection saw it leave), so its hook state is dropped. */
  z.object({ type: z.literal('agentExited') }),
  /** Ends every session and the daemon. Sent by `terminals:stop`, never by a running host. */
  z.object({ type: z.literal('stop') }),
])
export const requestTypes = new Set<string>(request.options.map((option) => option.shape.type.value))

export interface Peer {
  socket: Bun.Socket<unknown>
  decoder: DaemonDecoder
  /** The session this connection attached to, once it has. */
  session: SessionEntry | null
  queue: Buffer[]
  queued: number
  /** Waiting for the socket to drain after a partial write. */
  blocked: boolean
  /**
   * Frames held back while a snapshot is being taken. Output emitted after the snapshot was requested is not in
   * it, so it must reach the host after the snapshot, never before.
   */
  pending: Buffer[] | null
  /** Identifies the latest snapshot request; an older one that resolves late is ignored. */
  snapshotSeq: number
  /** A browser view is attached through this connection, so the session leaves queries to it. */
  viewing: boolean
  authTimer: ReturnType<typeof setTimeout>
}

export interface SessionEntry {
  id: string
  token: string
  core: TerminalCore
  peers: Set<Peer>
}

/** Bytes queued for one peer before it is dropped; the host reconnects with a fresh snapshot. */
export const MAX_QUEUE = 4 * 1024 * 1024

/** One validated host-to-daemon request. */
export type Request = z.infer<typeof request>
