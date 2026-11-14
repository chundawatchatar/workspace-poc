import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { routes } from '@orch/shared'
import {
  AgentChannel,
  type AgentTracking,
  agentSocketPath,
  agentTracking,
  DAEMON_PROTOCOL,
  DaemonDecoder,
  daemonBuild,
  encodeControlFrame,
  encodeOutputFrame,
  prepareAgentShim,
  shellProgram,
  TerminalCore,
  trackingForAll,
} from '@orch/terminal'
import { MAX_QUEUE, type Peer, type Request, request, requestTypes, type SessionEntry } from './requests'

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
 *
 * `argv` carries `--socket <path>` and optionally `--shell <program>`. It is
 * run by `main.ts` from source and by the host executable's daemon subcommand.
 */
export async function runDaemon(argv: string[]): Promise<void> {
  function option(key: string): string {
    const index = argv.indexOf(key)
    const value = index === -1 ? undefined : argv[index + 1]
    if (!value) throw new Error(`ptyd-bun: missing ${key}`)
    return value
  }

  const socketPath = option('--socket')
  const shell = argv.includes('--shell') ? option('--shell') : shellProgram()

  // Keep the socket and any files it writes readable only by this user.
  process.umask(0o077)
  const instance = randomBytes(16).toString('hex')
  /** When this daemon started, so the host can report its uptime. */
  const startedAt = Date.now()
  /** The code this daemon runs. A host built from different code warns, since a running daemon never reloads. */
  const build = daemonBuild(import.meta.dir)

  const peers = new Map<Bun.Socket<unknown>, Peer>()
  const sessions = new Map<string, SessionEntry>()
  const sendStatus = (entry: SessionEntry | undefined) => entry && broadcast(entry, statusMessage(entry))
  const notify = (id: string, message: string) => sessions.get(id)?.core.notify(message)
  const agents = new AgentChannel((id) => sendStatus(sessions.get(id)), notify)

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
        /** It takes the views' theme, and answers queries itself while no view is attached. */
        colors: true,
        /** It accepts `viewing` and `redraw`. */
        queries: true,
        build,
        startedAt,
        agentHook: agents.hook(entry.id),
      },
    }
  }

  /** The session answers queries itself only while no connection has a view attached. */
  function updateAnswering(entry: SessionEntry) {
    entry.core.answerQueries(![...entry.peers].some((peer) => peer.viewing))
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
    if (peer.session?.peers.delete(peer)) updateAnswering(peer.session)
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
  function ensureSession(
    id: string,
    token: string,
    cwd: string,
    cols: number,
    rows: number,
    tracking: AgentTracking | undefined,
  ): SessionEntry {
    const existing = sessions.get(id)
    if (existing) {
      if (existing.token !== token) throw new Error('terminal identity mismatch')
      if (tracking) agents.setTracking(id, tracking)
      return existing
    }
    // The core starts its shell while it is constructed, so the session's token must be ready to issue before that.
    agents.setTracking(id, tracking ?? trackingForAll(false))
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
      { issue: () => agents.issue(id), exited: () => agents.shellExited(id) },
    )
    sessions.set(id, entry)
    return entry
  }

  /** Ends one session, telling the peer that asked so it can remove the record. */
  function closeSession(entry: SessionEntry, ack?: Peer) {
    if (sessions.get(entry.id) === entry) sessions.delete(entry.id)
    agents.close(entry.id)
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

  /** Attaches a connection to its session, creating the session unless the host only wants to close it. */
  function hello(peer: Peer, message: Extract<Request, { type: 'hello' }>) {
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
      entry = ensureSession(message.id, message.token, message.cwd, message.cols, message.rows, message.tracking)
    } catch {
      drop(peer)
      return
    }
    clearTimeout(peer.authTimer)
    peer.session = entry
    peer.viewing = message.viewing
    entry.peers.add(peer)
    updateAnswering(entry)
    sendSnapshot(peer, entry)
  }

  /** Applies a request from a connection already attached to `entry`. */
  function sessionRequest(peer: Peer, entry: SessionEntry, message: Request) {
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
      case 'colors': {
        const parsed = routes.sockets.terminal.clientMessage.safeParse(message)
        if (parsed.success && parsed.data.type === 'colors') {
          const { type: _type, ...palette } = parsed.data
          entry.core.setPalette(palette)
        }
        break
      }
      case 'viewing':
        peer.viewing = message.on
        updateAnswering(entry)
        break
      case 'redraw':
        entry.core.redraw()
        break
      case 'idle':
        entry.core.idle()
        break
      case 'tracking':
        agents.setTracking(entry.id, agentTracking.parse(message))
        break
      case 'agentExited':
        agents.agentExited(entry.id)
        break
      case 'close':
        closeSession(entry, peer)
        break
    }
  }

  /** Tells a host of another protocol which one this daemon speaks, then closes. Its sessions are not touched. */
  function refuse(peer: Peer) {
    clearTimeout(peer.authTimer)
    peers.delete(peer.socket)
    peer.socket.end(encodeControlFrame({ type: 'refused', protocol: DAEMON_PROTOCOL }))
  }

  function handle(peer: Peer, value: unknown) {
    // A newer host may send requests this daemon predates; ignoring them keeps the connection usable.
    const type = (value as { type?: unknown } | null)?.type
    if (typeof type === 'string' && !requestTypes.has(type)) return
    // Checked before the full parse, since a host of another protocol may send a hello of another shape.
    const protocol = type === 'hello' ? (value as { protocol?: unknown }).protocol : undefined
    if (!peer.session && typeof protocol === 'number' && protocol !== DAEMON_PROTOCOL) {
      refuse(peer)
      return
    }
    let message: Request
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
      hello(peer, message)
      return
    }
    const entry = peer.session
    if (!entry) {
      drop(peer)
      return
    }
    sessionRequest(peer, entry, message)
  }

  let server: ReturnType<typeof listen> | null = null
  let agentServer: Bun.Server<undefined> | null = null
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
            viewing: false,
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
          } catch (error) {
            // A bad frame or a failing request costs this connection, never the other sessions.
            console.error('ptyd-bun: dropping a connection after an error', error)
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
      // Bun refuses a socket without a data or drain handler, which would make a live daemon look absent.
      const socket = await Bun.connect({ unix: socketPath, socket: { data() {} } })
      socket.end()
      return true
    } catch {
      return false
    }
  }

  /**
   * Binds the reporting channel. Terminals work without it, so a failure only means no shell gets a token. It runs
   * once `host.sock` is held, so a second daemon that loses that race never touches the live channel's socket.
   */
  function bindAgentChannel() {
    const path = agentSocketPath(socketPath)
    try {
      try {
        unlinkSync(path)
      } catch {}
      agentServer = Bun.serve({ unix: path, development: false, fetch: (request) => agents.handle(request) })
      chmodSync(path, 0o600)
      agents.open(path, prepareAgentShim(dirname(socketPath)))
      setInterval(() => agents.tick(), 100).unref()
    } catch (error) {
      agentServer?.stop(true)
      agentServer = null
      console.error('ptyd-bun: the agent channel is off', error instanceof Error ? error.message : 'unknown error')
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
    bindAgentChannel()
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
    agentServer?.stop(true)
    for (const path of agentServer ? [socketPath, agentSocketPath(socketPath)] : [socketPath]) {
      try {
        unlinkSync(path)
      } catch {}
    }
    process.exit(code)
  }

  process.on('SIGINT', () => shutdown(0))
  process.on('SIGTERM', () => shutdown(0))
  // Every terminal of the host lives in this process, so a bug in one session's callbacks must not end them all.
  process.on('uncaughtException', (error) => console.error('ptyd-bun: uncaught error', error))
  process.on('unhandledRejection', (error) => console.error('ptyd-bun: unhandled rejection', error))

  await start()
}
