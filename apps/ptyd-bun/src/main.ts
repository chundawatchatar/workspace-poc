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
 * A single terminal's owner process, written in Bun.
 *
 * It outlives the host so shells and agents survive a host restart. Control
 * messages are JSON; terminal output travels as binary frames, so a flood pays
 * neither base64 nor JSON on the daemon-to-host hop. The host launches it
 * detached; closing the tab sends `close`, which ends the shell.
 */

function option(key: string): string {
  const index = process.argv.indexOf(key)
  const value = index === -1 ? undefined : process.argv[index + 1]
  if (!value) throw new Error(`ptyd-bun: missing ${key}`)
  return value
}

const socketPath = option('--socket')
const id = option('--id')
const cwd = option('--cwd')
const shell = process.argv.includes('--shell') ? option('--shell') : shellProgram()
const cols = Number(process.argv[process.argv.indexOf('--cols') + 1] ?? 80)
const rows = Number(process.argv[process.argv.indexOf('--rows') + 1] ?? 24)
const token = process.env.ORCH_PTY_TOKEN
if (!token) {
  console.error('ptyd-bun: ORCH_PTY_TOKEN is required')
  process.exit(1)
}

// Keep the socket and any files it writes readable only by this user.
process.umask(0o077)

const instance = randomBytes(16).toString('hex')

/** The host-to-daemon control messages. */
const request = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), protocol: z.number().int(), id: z.string(), token: z.string() }),
  z.object({ type: z.literal('input'), data: z.string().max(64 * 1024) }),
  z.object({ type: z.literal('resize'), cols: z.number().int(), rows: z.number().int() }),
  z.object({ type: z.literal('clear') }),
  z.object({ type: z.literal('ack') }),
  z.object({ type: z.literal('colors') }).passthrough(),
  z.object({ type: z.literal('close') }),
  z.object({ type: z.literal('snapshot') }),
])

interface Peer {
  socket: Bun.Socket<unknown>
  decoder: DaemonDecoder
  authenticated: boolean
  queue: Buffer[]
  queued: number
  /** Waiting for the socket to drain after a partial write. */
  blocked: boolean
  authTimer: ReturnType<typeof setTimeout>
}

/** Bytes queued for one peer before it is dropped; the host reconnects with a fresh snapshot. */
const MAX_QUEUE = 4 * 1024 * 1024
const peers = new Map<Bun.Socket<unknown>, Peer>()

const core = new TerminalCore(
  id,
  cwd,
  Math.min(500, Math.max(2, cols)),
  Math.min(200, Math.max(2, rows)),
  (data) => {
    for (const peer of peers.values()) if (peer.authenticated) enqueue(peer, encodeOutputFrame(data))
  },
  () => broadcast(statusMessage()),
  shell,
)

function statusMessage() {
  const info = core.info()
  const { cols: current, rows: currentRows } = core.size
  return {
    type: 'status' as const,
    status: {
      protocol: DAEMON_PROTOCOL,
      id,
      instance,
      daemonPid: process.pid,
      pid: core.pid ?? null,
      alive: info.alive,
      title: info.title,
      attention: info.attention,
      progress: info.progress,
      cols: current,
      rows: currentRows,
    },
  }
}

function broadcast(value: unknown) {
  const frame = encodeControlFrame(value)
  for (const peer of peers.values()) if (peer.authenticated) enqueue(peer, frame)
}

async function sendSnapshot(peer: Peer) {
  const data = await core.snapshot()
  enqueue(peer, encodeControlFrame({ type: 'snapshot', data, status: statusMessage().status }))
}

function enqueue(peer: Peer, frame: Buffer) {
  peer.queue.push(frame)
  peer.queued += frame.byteLength
  if (peer.queued > MAX_QUEUE) {
    peer.socket.terminate()
    peers.delete(peer.socket)
    return
  }
  flush(peer)
}

function flush(peer: Peer) {
  if (peer.blocked) return
  while (peer.queue.length > 0) {
    const frame = peer.queue[0]
    const written = peer.socket.write(frame)
    if (written < 0) {
      peer.socket.terminate()
      peers.delete(peer.socket)
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

function handle(peer: Peer, value: unknown) {
  let message: z.infer<typeof request>
  try {
    message = request.parse(value)
  } catch {
    peer.socket.terminate()
    return
  }
  if (!peer.authenticated) {
    if (
      message.type !== 'hello' ||
      message.protocol !== DAEMON_PROTOCOL ||
      message.id !== id ||
      message.token !== token
    ) {
      peer.socket.terminate()
      return
    }
    peer.authenticated = true
    clearTimeout(peer.authTimer)
    void sendSnapshot(peer)
    return
  }
  switch (message.type) {
    case 'input':
      core.input(message.data)
      break
    case 'resize': {
      const next = {
        cols: Math.min(500, Math.max(2, message.cols)),
        rows: Math.min(200, Math.max(2, message.rows)),
      }
      if (next.cols !== core.size.cols || next.rows !== core.size.rows) {
        core.resize(next.cols, next.rows)
        broadcast(statusMessage())
      }
      break
    }
    case 'clear':
      // Alacritty and xterm.js clear alike, so every view gets the cleared screen as a new snapshot.
      void core.clear().then(async () => {
        const screen = await core.snapshot()
        const frame = encodeControlFrame({ type: 'snapshot', data: screen, status: statusMessage().status })
        for (const other of peers.values()) if (other.authenticated) enqueue(other, frame)
      })
      break
    case 'ack':
      core.ack()
      break
    case 'snapshot':
      void sendSnapshot(peer)
      break
    case 'colors':
      // This backend lets the browser answer colour queries, so the palette is unused.
      break
    case 'close':
      enqueue(peer, encodeControlFrame({ type: 'closed' }))
      setTimeout(() => shutdown(0), 50)
      break
    case 'hello':
      // A second handshake on an authenticated connection is a protocol error.
      peer.socket.terminate()
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
          authenticated: false,
          queue: [],
          queued: 0,
          blocked: false,
          authTimer: setTimeout(() => {}, 0),
        }
        // A connection that never authenticates must not hold a slot forever.
        peer.authTimer = setTimeout(() => {
          if (!peer.authenticated) {
            socket.terminate()
            peers.delete(socket)
          }
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
          socket.terminate()
          peers.delete(socket)
        }
      },
      drain(socket) {
        const peer = peers.get(socket)
        if (!peer) return
        peer.blocked = false
        flush(peer)
      },
      close(socket) {
        peers.delete(socket)
      },
      error(socket) {
        peers.delete(socket)
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
      console.error(`ptyd-bun: ${id} already has a live daemon`)
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
  for (const peer of peers.values()) {
    clearTimeout(peer.authTimer)
    peer.socket.terminate()
  }
  peers.clear()
  core.kill()
  server?.stop(true)
  try {
    unlinkSync(socketPath)
  } catch {}
  process.exit(code)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

await start()
