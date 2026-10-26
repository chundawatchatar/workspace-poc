import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { join, resolve } from 'node:path'
import {
  AGENT_LABELS,
  type AgentRef,
  type AppState,
  listPanes,
  type SessionInfo,
  type TermColors,
  type TermServerMsg,
} from '@orch/shared'
import {
  assignResponder,
  CAUGHT_UP,
  DAEMON_PROTOCOL,
  DaemonDecoder,
  type DaemonFrame,
  daemonBuild,
  daemonMessage,
  type daemonStatus,
  deliver,
  encodeControlFrame,
  type Foreground,
  resumeCommand,
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
  /** Runs while a view is stale, to resync it once it has caught up. */
  private resync: ReturnType<typeof setInterval> | null = null
  /** What the daemon was last told about attached views, so it answers queries only while there are none. */
  private viewing: boolean | null = null
  private record: DaemonRecord
  /** The agent in the foreground, as last identified, and its process. */
  private agent: AgentRef | null = null
  private agentPid: number | undefined
  /** Set while the daemon has lost this session and an agent was running in it; see `restore`. */
  private interrupted: SessionInfo['interrupted'] = null
  /** Set by `restore` until the daemon has started the new shell. */
  private restoring: { cwd: string; command: string | null } | null = null
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
    void this.connect()
  }

  /** The shell's pid, only while connected: a status kept from before a disconnect may name a shell that is gone. */
  get pid() {
    return (this.socket && this.status?.alive && this.status.pid) || undefined
  }

  info(): SessionInfo {
    return {
      id: this.id,
      alive: this.status?.alive ?? false,
      title: this.status?.title || 'Terminal',
      attention: this.status?.attention ?? null,
      progress: this.status?.progress ?? null,
      process: this.process,
      cwd: this.interrupted?.cwd ?? this.workingDir ?? this.record.cwd ?? this.cwd,
      agent: this.agent,
      interrupted: this.interrupted,
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
    if (found && !found.busy) {
      // The idle shell's directory is where it reopens should the daemon lose it.
      if (found.cwd) this.save({ cwd: found.cwd })
      if (this.status?.progress) this.send({ type: 'idle' })
    }
    if (JSON.stringify([next, cwd]) === JSON.stringify([this.process, this.workingDir])) return
    this.process = next
    this.workingDir = cwd
    this.onChange(this)
  }

  /**
   * Keeps the agent and its conversation on record as soon as they are known, so they can be resumed if the
   * daemon loses the session. While the conversation can't be told apart from another agent's in the folder, the
   * one this process had before is kept.
   */
  observeAgent(agent: AgentRef | null, ambiguous: boolean) {
    if (this.closing || this.interrupted) return
    const known = this.agent
    const pid = agent ? this.process?.pid : undefined
    const same = pid !== undefined && pid === this.agentPid && known?.kind === agent?.kind && known?.cwd === agent?.cwd
    const next =
      agent && !agent.sessionId && ambiguous && same ? { ...agent, sessionId: known?.sessionId ?? null } : agent
    this.agentPid = pid
    this.save({ agent: next })
    if (JSON.stringify(next) === JSON.stringify(known)) return
    this.agent = next
    this.onChange(this)
  }

  /** Starts an interrupted terminal again, in a new shell that runs the agent's resume command if asked to. */
  restore(mode: 'agent' | 'shell') {
    const interrupted = this.interrupted
    if (!interrupted || this.closing) return
    this.restoring = { cwd: interrupted.cwd, command: mode === 'agent' ? interrupted.command : null }
    this.interrupted = null
    // A plain shell was chosen over the agent, so it is not offered again.
    if (mode === 'shell') this.save({ agent: null })
    this.onChange(this)
    clearTimeout(this.retry)
    void this.connect()
  }

  attach(client: TermClient) {
    client.ready = false
    this.clients.add(client)
    if (this.interrupted) {
      this.showInterrupted(client)
      return
    }
    this.answer()
    this.requestSnapshot()
    if (this.status?.queries) this.send({ type: 'redraw' })
  }

  detach(client: TermClient) {
    this.clients.delete(client)
    if (this.controller === client) {
      this.controller = null
      const next = this.clients.values().next().value
      if (next) this.claim(next)
    }
    this.answer()
  }

  input(data: string, from: TermClient) {
    this.claim(from)
    // As with an exited shell, Enter in an interrupted terminal starts a plain shell.
    if (this.interrupted) {
      if (data.includes('\r')) this.restore('shell')
      return
    }
    this.send({ type: 'input', data })
  }

  resize(cols: number, rows: number, from: TermClient) {
    from.want = { cols, rows }
    if (!this.controller || !this.clients.has(this.controller)) this.controller = from
    if (this.controller === from) this.apply(cols, rows)
    else this.tell(from)
    this.answer()
  }

  claim(from: TermClient) {
    if (this.controller === from) return
    this.controller = from
    if (from.want) this.apply(from.want.cols, from.want.rows)
    this.answer()
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
    this.stopResync()
    if (this.socket) {
      this.send({ type: 'close' })
    } else if (!this.connecting) {
      void this.connect(false)
    }
  }

  shutdown() {
    this.stopped = true
    clearTimeout(this.retry)
    this.stopResync()
    this.socket?.destroy()
    this.clients.clear()
  }

  private save(patch: Partial<Pick<DaemonRecord, 'cwd' | 'agent'>>) {
    if (this.closing || this.stopped) return
    const record: Partial<DaemonRecord> = this.record
    const same = Object.entries(patch).every(([key, value]) => {
      return JSON.stringify(record[key as keyof DaemonRecord] ?? null) === JSON.stringify(value ?? null)
    })
    if (same) return
    try {
      this.record = this.shared.repository.update(this.id, patch)
    } catch (error) {
      console.error(`terminal ${this.id}: saving its record failed`, error)
    }
  }

  /** Shows a view the interrupted notice. The overlay in the web app offers the choices. */
  private showInterrupted(client: TermClient) {
    const interrupted = this.interrupted
    if (!interrupted) return
    const label = AGENT_LABELS[interrupted.agent.kind]
    const text =
      `\x1b[2m[The terminal daemon restarted while ${label} was running in ${interrupted.cwd}.\r\n` +
      ` Resume ${label}, or press Enter for a plain shell.]\x1b[0m\r\n`
    const { cols, rows } = this.size
    client.send(JSON.stringify({ type: 'snapshot', data: text, cols, rows } satisfies TermServerMsg))
    client.queue = []
    client.queued = 0
    client.stale = false
    client.ready = true
  }

  /** The daemon no longer has this session. An agent's terminal waits for the user rather than losing it silently. */
  private lose() {
    const agent = this.record.agent
    const command = agent && resumeCommand(agent)
    if (!agent || !command) throw new Error('Terminal daemon lost a session it was asked to create')
    this.interrupted = { agent, cwd: agent.cwd, command }
    this.agent = null
    this.agentPid = undefined
    this.process = null
    this.snapshotPending = false
    for (const client of this.clients) this.showInterrupted(client)
    this.onChange(this)
  }

  /**
   * One attached view answers terminal queries; the daemon answers them only
   * while no view is attached, and is told when that changes.
   */
  private answer() {
    const viewing = assignResponder(this.clients, this.controller)
    if (viewing === this.viewing || !this.status?.queries) return
    if (this.send({ type: 'viewing', on: viewing })) this.viewing = viewing
  }

  /** Resyncs stale views once their sockets have drained; the timer runs only while one is stale. */
  private watchStale() {
    if (this.resync !== null || ![...this.clients].some((client) => client.stale)) return
    this.resync = setInterval(() => {
      const stale = [...this.clients].filter((client) => client.stale)
      if (stale.length === 0) this.stopResync()
      else if (stale.some((client) => client.buffered() < CAUGHT_UP)) this.requestSnapshot()
    }, 100)
    this.resync.unref()
  }

  private stopResync() {
    if (this.resync !== null) clearInterval(this.resync)
    this.resync = null
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
      this.watchStale()
      return
    }
    const message = daemonMessage.parse(frame.value)
    if (message.type === 'closed') {
      // A session the daemon no longer has is acknowledged before any status. Unless closing, it was asked to
      // attach without creating one because an agent ran in it: the daemon restarted and lost it.
      if (!this.closing) {
        this.lose()
        return
      }
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
    if (first) {
      // A restored agent's resume command is typed ahead into its new shell, so it also lands in shell history.
      const command = this.restoring?.command
      this.restoring = null
      if (command) this.send({ type: 'input', data: `${command}\r` })
      if (message.status.colors && this.palette) this.send({ type: 'colors', ...this.palette })
      this.shared.heard(message.status)
      // The daemon learned whether views are attached from `hello`; ask a full-screen program to repaint for them.
      this.viewing = this.clients.size > 0
      if (message.status.queries && this.viewing) this.send({ type: 'redraw' })
    }
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
    const snapshot: Extract<TermServerMsg, { type: 'snapshot' }> = {
      type: 'snapshot',
      data: message.data,
      cols: message.status.cols,
      rows: message.status.rows,
    }
    // Only views that are behind get the snapshot; redrawing the others would flicker and lose their scroll position.
    for (const client of this.clients) {
      if (client.ready && !client.stale) continue
      client.queue = []
      client.queued = 0
      const serverQueries = !client.answers
      if (client.buffered() > 1024 * 1024 || client.send(JSON.stringify({ ...snapshot, serverQueries })) === 0) {
        client.stale = true
        client.ready = false
        continue
      }
      client.ready = true
      client.stale = false
    }
    this.watchStale()
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
      const text = `\r\nTerminal daemon unavailable: ${error instanceof Error ? error.message : String(error)}\r\n`
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
          // A lost plain shell reopens where it last was.
          cwd: this.restoring?.cwd ?? this.record.cwd ?? this.cwd,
          cols: this.size.cols,
          rows: this.size.rows,
          // Closing must not start a shell the daemon has already lost, and neither may a terminal that ran an
          // agent: it is shown as interrupted instead, so the agent can be resumed.
          create: !this.closing && (this.restoring !== null || !this.record.agent),
          viewing: this.clients.size > 0,
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
        if (verified && !this.stopped && !this.closing && !this.interrupted) this.scheduleRetry()
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
  /** The build of the daemon code on disk, which a newly started daemon runs. */
  private readonly build: string
  /** Daemon incarnations already reported as running other code, so each is reported once. */
  private readonly reported = new Set<string>()
  private lastStartedAt: number | null = null

  constructor(
    readonly repository: DaemonRepository,
    private readonly command: string[],
    private readonly shell: string,
  ) {
    this.build = daemonBuild(command[command.length - 1])
  }

  /** When the daemon last heard from started, in epoch milliseconds. Null until a status carried one. */
  get startedAt(): number | null {
    return this.lastStartedAt
  }

  /** Takes in the first status of a connection: remembers when that daemon started and checks its build. */
  heard(status: z.infer<typeof daemonStatus>) {
    this.lastStartedAt = status.startedAt ?? null
    this.checkBuild(status)
  }

  /**
   * Warns when the daemon runs code other than what is on disk. It never reloads, so a fix made since it
   * started (or a branch switch) does not reach the terminals it owns until it is stopped and started again.
   */
  private checkBuild(status: z.infer<typeof daemonStatus>) {
    if (status.build === this.build || this.reported.has(status.instance)) return
    this.reported.add(status.instance)
    console.warn(
      `terminal daemon (pid ${status.daemonPid}) runs ${status.build ? 'different' : 'older'} code than this host. ` +
        'Its terminals keep working, but changes to the daemon reach them only after a restart: stop `bun run dev`, ' +
        'then run `bun run terminals:stop` (this ends its shells).',
    )
  }

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

  // `Bun.connect` refuses a probe without data handlers, so this uses `node:net` like `stopDaemon`.
  private ping(): Promise<boolean> {
    return new Promise((done) => {
      const socket = createConnection(this.repository.socket)
      socket.on('connect', () => {
        socket.end()
        done(true)
      })
      socket.on('error', () => done(false))
    })
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
