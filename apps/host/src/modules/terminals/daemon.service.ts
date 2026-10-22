import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { join, resolve } from 'node:path'
import { type AppState, listPanes, type SessionInfo, type TermColors, type TermServerMsg } from '@orch/shared'
import {
  DAEMON_PROTOCOL,
  DaemonDecoder,
  type DaemonFrame,
  daemonMessage,
  type daemonStatus,
  deliver,
  encodeControlFrame,
  type Foreground,
  type SessionManager,
  shellEnv,
  shellProgram,
  type TermClient,
  type TerminalSession,
} from '@orch/terminal'
import type { z } from 'zod'
import { type DaemonRecord, DaemonRepository } from './daemon.repository'

/** A browser-facing terminal whose shell and screen belong to a separate process. */
export class DaemonSession implements TerminalSession {
  readonly createdAt = Date.now()
  private readonly clients = new Set<TermClient>()
  private socket: Socket | null = null
  private status: z.infer<typeof daemonStatus> | null = null
  private process: SessionInfo['process'] = null
  private workingDir: string | null = null
  private controller: TermClient | null = null
  private stopped = false
  private closing = false
  private closeAcknowledged = false
  private connecting = false
  private snapshotPending = false
  private retry: ReturnType<typeof setTimeout> | undefined
  private readonly resync: ReturnType<typeof setInterval>
  private readonly record: DaemonRecord
  private size: { cols: number; rows: number }
  /** The latest view theme, resent on every connection so a new daemon answers colour queries with it. */
  private palette: TermColors | null = null

  constructor(
    readonly id: string,
    private readonly cwd: string,
    cols: number,
    rows: number,
    private readonly onChange: (session: TerminalSession) => void,
    private readonly shared: SharedDaemon,
  ) {
    this.record = shared.repository.get(id)
    this.size = { cols, rows }
    this.resync = setInterval(() => {
      if ([...this.clients].some((client) => client.stale && client.buffered() < 128 * 1024)) this.requestSnapshot()
    }, 100)
    this.resync.unref()
    void this.connect()
  }

  get pid() {
    return this.status?.pid ?? undefined
  }

  info(): SessionInfo {
    return {
      id: this.id,
      alive: this.status?.alive ?? false,
      title: this.status?.title || 'Terminal',
      attention: this.status?.attention ?? null,
      progress: this.status?.progress ?? null,
      process: this.process,
      cwd: this.workingDir ?? this.cwd,
    }
  }

  observe(found: (Foreground & { cwd: string | null }) | undefined) {
    const running = found?.busy ? found.process : null
    const next = running
      ? {
          pid: running.pid,
          name: running.name,
          command: running.command,
          startedAt:
            this.process?.pid === running.pid
              ? this.process.startedAt
              : Math.round(Date.now() / 1000 - running.elapsed) * 1000,
        }
      : null
    const cwd = found?.cwd ?? this.workingDir
    if (JSON.stringify([next, cwd]) === JSON.stringify([this.process, this.workingDir])) return
    this.process = next
    this.workingDir = cwd
    this.onChange(this)
  }

  attach(client: TermClient) {
    client.ready = false
    this.clients.add(client)
    this.requestSnapshot()
  }

  detach(client: TermClient) {
    this.clients.delete(client)
    if (this.controller !== client) return
    this.controller = null
    const next = this.clients.values().next().value
    if (next) this.claim(next)
  }

  input(data: string, from: TermClient) {
    this.claim(from)
    this.send({ type: 'input', data })
  }

  resize(cols: number, rows: number, from: TermClient) {
    from.want = { cols, rows }
    if (!this.controller || !this.clients.has(this.controller)) this.controller = from
    if (this.controller === from) this.apply(cols, rows)
    else this.tell(from)
  }

  claim(from: TermClient) {
    if (this.controller === from) return
    this.controller = from
    if (from.want) this.apply(from.want.cols, from.want.rows)
  }

  /** The daemon answers with a snapshot of the cleared screen; views take it only while not ready. */
  clear() {
    if (!this.send({ type: 'clear' })) return
    for (const client of this.clients) client.ready = false
  }

  ack() {
    this.send({ type: 'ack' })
  }

  colors(palette: TermColors) {
    this.palette = palette
    if (this.status?.colors) this.send({ type: 'colors', ...palette })
  }

  kill() {
    this.closing = true
    clearTimeout(this.retry)
    clearInterval(this.resync)
    if (this.socket) {
      this.send({ type: 'close' })
    } else if (!this.connecting) {
      void this.connect(false)
    }
  }

  shutdown() {
    this.stopped = true
    clearTimeout(this.retry)
    clearInterval(this.resync)
    this.socket?.destroy()
    this.clients.clear()
  }

  private apply(cols: number, rows: number) {
    cols = Math.max(2, Math.min(500, cols))
    rows = Math.max(2, Math.min(200, rows))
    this.size = { cols, rows }
    if (this.status?.cols !== cols || this.status.rows !== rows) this.send({ type: 'resize', cols, rows })
  }

  private tell(client: TermClient) {
    if (client.ready && this.status) {
      client.send(
        JSON.stringify({ type: 'size', cols: this.status.cols, rows: this.status.rows } satisfies TermServerMsg),
      )
    }
  }

  private requestSnapshot() {
    if (this.snapshotPending || !this.socket) return
    this.snapshotPending = this.send({ type: 'snapshot' })
  }

  private send(message: unknown) {
    if (!this.socket || this.socket.destroyed) return false
    if (this.socket.writableLength > 1024 * 1024) {
      this.socket.destroy(new Error('Terminal daemon input queue is full'))
      return false
    }
    this.socket.write(encodeControlFrame(message))
    return true
  }

  private receive(frame: DaemonFrame) {
    if (frame.kind === 'output') {
      if (!this.status) throw new Error('Terminal output arrived before its identity')
      for (const client of this.clients) deliver(client, frame.bytes)
      return
    }
    const message = daemonMessage.parse(frame.value)
    if (message.type === 'closed') {
      // A session the daemon no longer has is acknowledged before any status.
      if (!this.closing) throw new Error('Unexpected daemon close acknowledgement')
      this.closeAcknowledged = true
      return
    }
    if (message.status.id !== this.id) throw new Error('Terminal daemon returned a different session identity')
    if (this.status && this.socket && this.status.instance !== message.status.instance) {
      throw new Error('Terminal daemon incarnation changed within a connection')
    }
    const resized =
      this.status && (this.status.cols !== message.status.cols || this.status.rows !== message.status.rows)
    // The first status of a connection says whether this daemon takes the theme; one from an older build doesn't.
    const first = this.status === null
    this.status = message.status
    if (first && message.status.colors && this.palette) this.send({ type: 'colors', ...this.palette })
    if (!message.status.alive) this.process = null
    this.onChange(this)
    if (this.closing) {
      this.send({ type: 'close' })
      return
    }
    // A resize reflows the daemon's screen and xterm.js the same way, so up-to-date views only need the new size.
    if (resized) for (const client of this.clients) this.tell(client)
    if (message.type !== 'snapshot') return
    this.snapshotPending = false
    const snapshot: TermServerMsg = {
      type: 'snapshot',
      data: message.data,
      cols: message.status.cols,
      rows: message.status.rows,
      // A daemon that answers colour queries itself tells the browser to stay quiet; the Bun backend does not.
      serverQueries: message.status.colors === true,
    }
    const encoded = JSON.stringify(snapshot)
    // Only views that are behind get the snapshot; redrawing the others would flicker and lose their scroll position.
    for (const client of this.clients) {
      if (client.ready && !client.stale) continue
      client.queue = []
      client.queued = 0
      if (client.buffered() > 1024 * 1024 || client.send(encoded) === 0) {
        client.stale = true
        client.ready = false
        continue
      }
      client.ready = true
      client.stale = false
    }
  }

  private async connect(allowLaunch = true) {
    if (this.connecting || this.stopped) return
    this.connecting = true
    try {
      try {
        await this.open()
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (!allowLaunch || this.closing || !['ENOENT', 'ECONNREFUSED'].includes(code ?? '')) throw error
        if (this.stopped) return
        await this.shared.ensureStarted()
        if (this.stopped) return
        await this.open()
      }
    } catch (error) {
      if (this.stopped) return
      console.error(`terminal ${this.id}:`, error)
      const text = `\r\nTerminal backend unavailable: ${error instanceof Error ? error.message : String(error)}\r\n`
      for (const client of this.clients) {
        client.send(JSON.stringify({ type: 'snapshot', cols: 80, rows: 24, data: text } satisfies TermServerMsg))
      }
      if (this.closing) {
        // A refused socket means there is no owner to close; identity failures keep their record for diagnosis.
        if (['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? ''))
          this.shared.repository.remove(this.id)
      } else this.scheduleRetry()
    } finally {
      this.connecting = false
    }
  }

  private open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.shared.repository.socket)
      const decoder = new DaemonDecoder()
      let verified = false
      const deadline = setTimeout(() => socket.destroy(new Error('Terminal daemon handshake timed out')), 3000)
      socket.on('connect', () => {
        if (this.stopped) return socket.destroy()
        this.socket = socket
        this.status = null
        this.snapshotPending = true
        // Views missed whatever was written while disconnected, so all of them take this connection's snapshot.
        for (const client of this.clients) client.ready = false
        this.send({
          type: 'hello',
          protocol: DAEMON_PROTOCOL,
          id: this.id,
          token: this.record.token,
          cwd: this.cwd,
          cols: this.size.cols,
          rows: this.size.rows,
          // Closing must not start a shell the daemon has already lost.
          create: !this.closing,
        })
      })
      socket.on('data', (chunk: Buffer) => {
        if (this.stopped || this.socket !== socket) return
        try {
          for (const frame of decoder.push(chunk)) {
            this.receive(frame)
            if (!verified) {
              verified = true
              clearTimeout(deadline)
              resolve()
            }
          }
        } catch (error) {
          socket.destroy(error instanceof Error ? error : new Error(String(error)))
        }
      })
      socket.on('error', (error) => {
        if (!verified) reject(error)
      })
      socket.on('close', () => {
        clearTimeout(deadline)
        if (this.socket === socket) this.socket = null
        this.snapshotPending = false
        if (!verified) reject(new Error('Terminal daemon closed before authentication'))
        if (this.closing && this.closeAcknowledged) this.shared.repository.remove(this.id)
        if (verified && !this.stopped && !this.closing) this.scheduleRetry()
      })
    })
  }

  private scheduleRetry() {
    clearTimeout(this.retry)
    this.retry = setTimeout(() => void this.connect(), 1000)
  }
}

/**
 * Authenticates to one registered daemon and asks it to end its terminal. A record whose socket is gone is
 * stale and removed; a daemon that fails the identity check is left running, with its record kept for diagnosis.
 */
export function closeDaemon(
  repository: DaemonRepository,
  record: DaemonRecord,
): Promise<'closed' | 'stale' | 'failed'> {
  return new Promise((done) => {
    const socket = createConnection(repository.socket)
    const decoder = new DaemonDecoder()
    let verified = false
    let result: 'closed' | 'stale' | 'failed' = 'failed'
    const deadline = setTimeout(() => socket.destroy(new Error('Daemon close timed out')), 3000)
    socket.on('connect', () =>
      socket.write(
        encodeControlFrame({
          type: 'hello',
          protocol: DAEMON_PROTOCOL,
          id: record.id,
          token: record.token,
          create: false,
        }),
      ),
    )
    socket.on('data', (chunk: Buffer) => {
      try {
        for (const frame of decoder.push(chunk)) {
          if (frame.kind !== 'control') continue
          const message = daemonMessage.parse(frame.value)
          if (verified || message.type === 'closed') {
            if (message.type === 'closed') result = 'closed'
            continue
          }
          if (message.type !== 'snapshot' || message.status.id !== record.id)
            throw new Error('Daemon identity mismatch')
          verified = true
          socket.write(encodeControlFrame({ type: 'close' }))
        }
      } catch (error) {
        console.error(`terminal ${record.id}:`, error)
        socket.destroy()
      }
    })
    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (['ENOENT', 'ECONNREFUSED'].includes(error.code ?? '')) result = 'stale'
      else console.error(`terminal ${record.id}:`, error.message)
    })
    socket.on('close', () => {
      clearTimeout(deadline)
      if (result !== 'failed') repository.remove(record.id)
      done(result)
    })
  })
}

/**
 * Reattaches every terminal in the starting layout to its daemon, then ends daemons the layout no longer has:
 * daemons outlive the layout file, so deleting it to reset the layout would otherwise leave them running unseen.
 * An unreadable layout is no proof they are orphaned, so then they are only counted.
 */
export function restoreTerminals(
  layout: { state: AppState; origin: 'file' | 'missing' | 'invalid' },
  sessions: SessionManager,
  factory: ReturnType<typeof daemonFactory>,
): Promise<void> {
  const liveIds = new Set<string>()
  for (const workspace of layout.state.workspaces) {
    for (const surface of listPanes(workspace.root).flatMap((pane) => pane.surfaces)) {
      if (surface.kind !== 'terminal') continue
      liveIds.add(surface.id)
      sessions.ensure(surface.id, workspace.cwd, 80, 24)
    }
  }
  if (layout.origin !== 'invalid') return factory.reconcile(liveIds)
  const orphans = factory.repository.list().filter((record) => !liveIds.has(record.id)).length
  if (orphans) console.warn(`layout could not be read; keeping ${orphans} terminal daemon(s) it may still refer to`)
  return Promise.resolve()
}

/**
 * One daemon for every terminal of this host. It owns each session's shell and
 * screen so they outlive the host, while sharing one Bun runtime between them.
 */
export class SharedDaemon {
  private starting: Promise<void> | null = null

  constructor(
    readonly repository: DaemonRepository,
    private readonly command: string[],
    private readonly shell: string,
  ) {}

  /**
   * Starts the daemon if its socket is not answering. Concurrent callers share
   * one attempt, and a daemon that has since exited is started again rather than
   * trusted because it was up once.
   */
  async ensureStarted(): Promise<void> {
    if (await this.ping()) return
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = null
      })
    }
    return this.starting
  }

  private async start() {
    this.launch()
    for (let attempt = 0; attempt < 100; attempt++) {
      await Bun.sleep(50)
      if (await this.ping()) return
    }
    throw new Error('Terminal daemon did not start; inspect its log in the runtime folder')
  }

  private async ping(): Promise<boolean> {
    try {
      const socket = await Bun.connect({ unix: this.repository.socket, socket: {} })
      socket.end()
      return true
    } catch {
      return false
    }
  }

  private launch() {
    const log = openSync(join(this.repository.runtime, 'host.log'), 'a', 0o600)
    try {
      const [program, ...prefix] = this.command
      const child = spawn(program, [...prefix, '--socket', this.repository.socket, '--shell', this.shell], {
        detached: true,
        stdio: ['ignore', log, log],
        env: shellEnv(process.env),
      })
      child.on('error', (error) => console.error('launching terminal daemon failed', error))
      child.unref()
    } finally {
      closeSync(log)
    }
  }
}

/** Asks the shared daemon to end every session and exit. Used by `terminals:stop`. */
export function stopDaemon(repository: DaemonRepository): Promise<'stopped' | 'absent'> {
  return new Promise((done) => {
    const socket = createConnection(repository.socket)
    socket.on('connect', () => {
      socket.end(encodeControlFrame({ type: 'stop' }))
      done('stopped')
    })
    socket.on('error', (error: NodeJS.ErrnoException) => {
      done(['ENOENT', 'ECONNREFUSED'].includes(error.code ?? '') ? 'absent' : 'stopped')
    })
  })
}

/** Creates the one persistent daemon and the terminals that attach to it. */
export function daemonFactory(hostRoot: string) {
  const repository = new DaemonRepository(hostRoot)
  const shared = new SharedDaemon(
    repository,
    [process.execPath, resolve(hostRoot, '../ptyd-bun/src/main.ts')],
    shellProgram(),
  )
  return {
    repository,
    shared,
    create: (id: string, cwd: string, cols: number, rows: number, onChange: (session: TerminalSession) => void) =>
      new DaemonSession(id, cwd, cols, rows, onChange, shared),
    /** Ends sessions whose terminal is no longer in the layout. Call it only with a layout that loaded or was absent. */
    reconcile: async (liveIds: Set<string>) => {
      const orphans = repository.list().filter((record) => !liveIds.has(record.id))
      const results = await Promise.all(orphans.map((record) => closeDaemon(repository, record)))
      const closed = results.filter((result) => result === 'closed').length
      if (closed) console.log(`closed ${closed} terminal session(s) that are no longer in the layout`)
    },
  }
}
