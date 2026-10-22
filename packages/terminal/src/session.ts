import type { SessionInfo, TermServerMsg } from '@orch/shared'
import { CAUGHT_UP, deliver, type TermClient, TerminalCore, type TerminalSession } from './core'
import { type Foreground, inspectShells } from './processes'

/**
 * A shell the host owns in its own process, on a pseudo-terminal that outlives
 * any browser connection. Browser views attach to it and see the same screen.
 */
export class Session implements TerminalSession {
  readonly id: string
  readonly createdAt: number
  private readonly clients = new Set<TermClient>()
  private readonly core: TerminalCore
  /** Runs while a client is stale, to resync it once it has caught up. */
  private resyncTimer: ReturnType<typeof setInterval> | null = null
  /** The view whose size the session follows: the one last typed in or focused. */
  private controller: TermClient | null = null

  constructor(
    id: string,
    cwd: string,
    cols: number,
    rows: number,
    private readonly onChange: (session: TerminalSession) => void,
  ) {
    this.id = id
    this.core = new TerminalCore(
      id,
      cwd,
      cols,
      rows,
      (data) => this.output(data),
      () => this.onChange(this),
    )
    this.createdAt = this.core.createdAt
  }

  get pid(): number | undefined {
    return this.core.pid
  }

  info(): SessionInfo {
    return this.core.info()
  }

  observe(found: (Foreground & { cwd: string | null }) | undefined) {
    this.core.observe(found)
  }

  ack() {
    this.core.ack()
  }

  attach(client: TermClient) {
    this.clients.add(client)
    this.sync(client)
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
    this.core.input(data)
  }

  /**
   * A view reports the size its pane can show. With several views open at
   * different sizes, only the controller's is applied; the others are told
   * the size in force and display that.
   */
  resize(cols: number, rows: number, from: TermClient) {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2) return
    from.want = { cols, rows }
    if (!this.controller || !this.clients.has(this.controller)) this.controller = from
    if (this.controller === from) this.apply(cols, rows)
    else this.tell(from)
  }

  /** Typing in a view or focusing it puts it in control, and the session takes its size. */
  claim(from: TermClient) {
    if (this.controller === from) return
    this.controller = from
    if (from.want) this.apply(from.want.cols, from.want.rows)
  }

  clear() {
    void this.core.clear().then(() => {
      for (const client of this.clients) this.sync(client)
    })
  }

  /** Colour queries reach the browser's own terminal, which answers them, so this backend needs no theme. */
  colors() {}

  kill() {
    this.stopResync()
    this.core.kill()
    this.clients.clear()
  }

  /** Ends this in-process shell when its host stops. */
  shutdown() {
    this.kill()
  }

  private apply(cols: number, rows: number) {
    const { cols: current, rows: currentRows } = this.core.size
    if (cols === current && rows === currentRows) return
    this.core.resize(cols, rows)
    for (const client of this.clients) this.tell(client)
  }

  private output(data: Uint8Array) {
    for (const client of this.clients) deliver(client, data)
    if (this.resyncTimer === null && [...this.clients].some((client) => client.stale)) {
      this.resyncTimer = setInterval(() => this.resyncCaughtUp(), 100)
    }
  }

  private resyncCaughtUp() {
    let waiting = false
    for (const client of this.clients) {
      if (!client.stale) continue
      if (client.ready && client.buffered() < CAUGHT_UP) this.sync(client)
      else waiting = true
    }
    if (!waiting) this.stopResync()
  }

  private stopResync() {
    if (this.resyncTimer !== null) clearInterval(this.resyncTimer)
    this.resyncTimer = null
  }

  /** Sends the client the current screen, followed by any output that arrives meanwhile. */
  private sync(client: TermClient) {
    client.ready = false
    client.stale = false
    client.queue = []
    client.queued = 0
    void this.core.snapshot().then((data) => {
      if (!this.clients.has(client)) return
      const { cols, rows } = this.core.size
      client.send(JSON.stringify({ type: 'snapshot', data, cols, rows } satisfies TermServerMsg))
      // A client whose queue overflowed stays stale and is resynced again.
      for (const chunk of client.queue) client.send(chunk)
      client.queue = []
      client.queued = 0
      client.ready = true
    })
  }

  private tell(client: TermClient) {
    if (!client.ready) return
    const { cols, rows } = this.core.size
    client.send(JSON.stringify({ type: 'size', cols, rows } satisfies TermServerMsg))
  }
}

export class SessionManager {
  private readonly sessions = new Map<string, TerminalSession>()

  constructor(
    private readonly onChange: (session: TerminalSession) => void,
    private readonly onGone: (id: string) => void,
    private readonly create: (
      id: string,
      cwd: string,
      cols: number,
      rows: number,
      onChange: (session: TerminalSession) => void,
    ) => TerminalSession = (id, cwd, cols, rows, onChange) => new Session(id, cwd, cols, rows, onChange),
  ) {}

  get(id: string) {
    return this.sessions.get(id)
  }

  list() {
    return [...this.sessions.values()]
  }

  /** Terminates a terminal when its tab is explicitly removed from the layout. */
  close(id: string) {
    const session = this.sessions.get(id)
    if (!session) return
    session.kill()
    this.sessions.delete(id)
    this.onGone(id)
  }

  ensure(id: string, cwd: string, cols: number, rows: number): TerminalSession {
    let session = this.sessions.get(id)
    if (!session) {
      session = this.create(id, cwd, cols, rows, this.onChange)
      this.sessions.set(id, session)
      this.onChange(session)
    }
    return session
  }

  /** Ends sessions whose tab no longer exists. New ones get a grace period to appear in the layout. */
  collect(liveIds: Set<string>) {
    for (const [id, session] of this.sessions) {
      if (liveIds.has(id) || Date.now() - session.createdAt < 10_000) continue
      this.close(id)
    }
  }

  /** Refreshes what every live shell is running. Sessions report a change through `onChange`. */
  async inspect() {
    const live = this.list().filter((session) => session.pid !== undefined)
    if (live.length === 0) return
    const found = await inspectShells(live.map((session) => session.pid as number))
    for (const session of live) {
      if (session.pid !== undefined) session.observe(found.get(session.pid))
    }
  }

  killAll() {
    for (const session of this.sessions.values()) session.kill()
    this.sessions.clear()
  }

  /** Disconnects persistent terminals and ends terminals owned by this host. */
  shutdown() {
    for (const session of this.sessions.values()) session.shutdown()
    this.sessions.clear()
  }
}
