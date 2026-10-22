import { randomBytes } from 'node:crypto'
import { existsSync, unlinkSync } from 'node:fs'
import {
  DAEMON_PROTOCOL,
  DaemonDecoder,
  encodeControlFrame,
  encodeOutputFrame,
  shellProgram,
  TerminalCore,
} from '@orch/terminal'
import { z } from 'zod'

/**
 * The owner process for every terminal of one host.
 *
 * It outlives the host so shells and agents survive a host restart, and it holds
 * every session in one process so they share one Bun runtime. Each terminal gets
 * its own shell and its own connection to this daemon's socket; closing a tab
 * ends that session, not the daemon. Control messages are JSON, output is binary
 * frames.
 *
 * Sessions are addressed by the `id` and `token` in `hello`. The first hello for
 * an id creates the session; later ones attach and must present the same token.
 * This is what lets a restarted host pick its terminals back up.
 */

function option(key: string): string {
  const index = process.argv.indexOf(key)
  const value = index === -1 ? undefined : process.argv[index + 1]
  if (!value) throw new Error(`ptyd-bun: missing ${key}`)
  return value
}

const socketPath = option('--socket')
const shell = process.argv.includes('--shell') ? option('--shell') : shellProgram()

// Keep the socket and any files it writes readable only by this user.
process.umask(0o077)
const instance = randomBytes(16).toString('hex')

/** The host-to-daemon messages. Every session request is bound to the connection that attached it. */
const request = z.discriminatedUnion('type', [
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
  }),
  z.object({ type: z.literal('input'), data: z.string().max(64 * 1024) }),
  z.object({ type: z.literal('resize'), cols: z.number().int(), rows: z.number().int() }),
  z.object({ type: z.literal('clear') }),
  z.object({ type: z.literal('ack') }),
  z.object({ type: z.literal('colors') }).passthrough(),
  z.object({ type: z.literal('close') }),
  z.object({ type: z.literal('snapshot') }),
  /** Ends every session and the daemon. Sent by `terminals:stop`, never by a running host. */
  z.object({ type: z.literal('stop') }),
])

interface Peer {
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
  authTimer: ReturnType<typeof setTimeout>
}

interface SessionEntry {
  id: string
  token: string
  core: TerminalCore
  peers: Set<Peer>
}

/** Bytes queued for one peer before it is dropped; the host reconnects with a fresh snapshot. */
const MAX_QUEUE = 4 * 1024 * 1024
const peers = new Map<Bun.Socket<unknown>, Peer>()
const sessions = new Map<string, SessionEntry>()

function statusMessage(entry: SessionEntry) {
  const info = entry.core.info()
  const { cols, rows } = entry.core.size
  return {
    type: 'status' as const,
    status: {
      protocol: DAEMON_PROTOCOL,
      id: entry.id,
      instance,
      daemonPid: process.pid,
      pid: entry.core.pid ?? null,
      alive: info.alive,
      title: info.title,
      attention: info.attention,
      progress: info.progress,
      cols,
      rows,
    },
  }
}

function broadcast(entry: SessionEntry, value: unknown) {
  const frame = encodeControlFrame(value)
  for (const peer of entry.peers) enqueue(peer, frame)
}

/**
 * Sends the peer the current screen, then the frames emitted after it was requested. A newer request supersedes
 * an older one: its snapshot already contains whatever the older one held back.
 */
function sendSnapshot(peer: Peer, entry: SessionEntry) {
  const seq = ++peer.snapshotSeq
  if (peer.pending) for (const frame of peer.pending) peer.queued -= frame.byteLength
  peer.pending = []
  entry.core.snapshot().then(
    (data) => {
      if (seq !== peer.snapshotSeq || !entry.peers.has(peer)) return
      const held = peer.pending ?? []
      peer.pending = null
      const frame = encodeControlFrame({ type: 'snapshot', data, status: statusMessage(entry).status })
      peer.queued += frame.byteLength
      peer.queue.push(frame, ...held)
      flush(peer)
    },
    () => {},
  )
}

function enqueue(peer: Peer, frame: Buffer) {
  if (peer.pending) peer.pending.push(frame)
  else peer.queue.push(frame)
  peer.queued += frame.byteLength
  if (peer.queued > MAX_QUEUE) {
    drop(peer)
    return
  }
  if (!peer.pending) flush(peer)
}

/** Forgets a connection everywhere it is referenced, so a dead peer never keeps queueing output. */
function drop(peer: Peer) {
  clearTimeout(peer.authTimer)
  peer.session?.peers.delete(peer)
  peers.delete(peer.socket)
  peer.socket.terminate()
}

function flush(peer: Peer) {
  if (peer.blocked) return
  while (peer.queue.length > 0) {
    const frame = peer.queue[0]
    const written = peer.socket.write(frame)
    if (written < 0) {
      drop(peer)
      return
    }
    if (written < frame.byteLength) {
      peer.queue[0] = frame.subarray(written)
      peer.queued -= written
      peer.blocked = true
      return
    }
    peer.queued -= frame.byteLength
    peer.queue.shift()
  }
}

/** Creates the session for an id if needed; an existing one must present the same token. */
function ensureSession(id: string, token: string, cwd: string, cols: number, rows: number): SessionEntry {
  const existing = sessions.get(id)
  if (existing) {
    if (existing.token !== token) throw new Error('terminal identity mismatch')
    return existing
  }
  // The core's callbacks close over `entry`, so fill it in after construction.
  const entry = { id, token, core: undefined as unknown as TerminalCore, peers: new Set<Peer>() }
  entry.core = new TerminalCore(
    id,
    cwd,
    Math.min(500, Math.max(2, cols)),
    Math.min(200, Math.max(2, rows)),
    (data) => {
      const frame = encodeOutputFrame(data)
      for (const peer of entry.peers) enqueue(peer, frame)
    },
    () => broadcast(entry, statusMessage(entry)),
    shell,
  )
  sessions.set(id, entry)
  return entry
}

/** Ends one session, telling the peer that asked so it can remove the record. */
function closeSession(entry: SessionEntry, ack?: Peer) {
  if (sessions.get(entry.id) === entry) sessions.delete(entry.id)
  entry.core.kill()
  for (const peer of [...entry.peers]) {
    if (peer === ack) acknowledgeClose(peer)
    else drop(peer)
  }
  entry.peers.clear()
}

/** Tells a peer its session is gone, ahead of anything held back for a snapshot that will never come. */
function acknowledgeClose(peer: Peer) {
  peer.session?.peers.delete(peer)
  peer.session = null
  peer.pending = null
  peer.queue = []
  peer.queued = 0
  enqueue(peer, encodeControlFrame({ type: 'closed' }))
  setTimeout(() => peer.socket.end(), 50)
}

function handle(peer: Peer, value: unknown) {
  let message: z.infer<typeof request>
  try {
    message = request.parse(value)
  } catch {
    drop(peer)
    return
  }
  if (message.type === 'stop') {
    shutdown(0)
    return
  }
  if (message.type === 'hello') {
    if (peer.session || message.protocol !== DAEMON_PROTOCOL) {
      drop(peer)
      return
    }
    if (!message.create && !sessions.has(message.id)) {
      clearTimeout(peer.authTimer)
      acknowledgeClose(peer)
      return
    }
    let entry: SessionEntry
    try {
      entry = ensureSession(message.id, message.token, message.cwd, message.cols, message.rows)
    } catch {
      drop(peer)
      return
    }
    clearTimeout(peer.authTimer)
    peer.session = entry
    entry.peers.add(peer)
    sendSnapshot(peer, entry)
    return
  }
  const entry = peer.session
  if (!entry) {
    drop(peer)
    return
  }
  switch (message.type) {
    case 'input':
      entry.core.input(message.data)
      break
    case 'resize': {
      const cols = Math.min(500, Math.max(2, message.cols))
      const rows = Math.min(200, Math.max(2, message.rows))
      if (cols !== entry.core.size.cols || rows !== entry.core.size.rows) {
        entry.core.resize(cols, rows)
        broadcast(entry, statusMessage(entry))
      }
      break
    }
    case 'clear':
      // Every view gets the cleared screen as a new snapshot; it is taken after the clear is applied.
      void entry.core.clear()
      for (const view of entry.peers) sendSnapshot(view, entry)
      break
    case 'ack':
      entry.core.ack()
      break
    case 'snapshot':
      sendSnapshot(peer, entry)
      break
    case 'colors':
      // This backend lets the browser answer colour queries, so the palette is unused.
      break
    case 'close':
      closeSession(entry, peer)
      break
  }
}

let server: ReturnType<typeof listen> | null = null
let stopping = false

function listen() {
  return Bun.listen({
    unix: socketPath,
    socket: {
      binaryType: 'buffer',
      open(socket) {
        const peer: Peer = {
          socket,
          decoder: new DaemonDecoder(),
          session: null,
          queue: [],
          queued: 0,
          blocked: false,
          pending: null,
          snapshotSeq: 0,
          authTimer: setTimeout(() => {}, 0),
        }
        // A connection that never authenticates must not hold a slot forever.
        peer.authTimer = setTimeout(() => {
          if (!peer.session) drop(peer)
        }, 3000)
        peers.set(socket, peer)
      },
      data(socket, data) {
        const peer = peers.get(socket)
        if (!peer) return
        try {
          for (const frame of peer.decoder.push(Buffer.from(data))) {
            if (frame.kind === 'control') handle(peer, frame.value)
          }
        } catch {
          drop(peer)
        }
      },
      drain(socket) {
        const peer = peers.get(socket)
        if (!peer) return
        peer.blocked = false
        flush(peer)
      },
      close(socket) {
        const peer = peers.get(socket)
        if (peer) drop(peer)
      },
      error(socket) {
        const peer = peers.get(socket)
        if (peer) drop(peer)
      },
    },
  })
}

/** Connects once to see whether a live daemon owns a socket left over from a crash. */
async function liveDaemon(): Promise<boolean> {
  if (!existsSync(socketPath)) return false
  try {
    const socket = await Bun.connect({ unix: socketPath, socket: {} })
    socket.end()
    return true
  } catch {
    return false
  }
}

async function start() {
  try {
    server = listen()
  } catch {
    if (await liveDaemon()) {
      console.error('ptyd-bun: this host already has a live daemon')
      process.exit(1)
    }
    try {
      unlinkSync(socketPath)
    } catch {}
    server = listen()
  }
}

function shutdown(code: number) {
  if (stopping) return
  stopping = true
  for (const entry of sessions.values()) entry.core.kill()
  sessions.clear()
  for (const peer of peers.values()) {
    clearTimeout(peer.authTimer)
    peer.socket.terminate()
  }
  peers.clear()
  server?.stop(true)
  try {
    unlinkSync(socketPath)
  } catch {}
  process.exit(code)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

await start()
