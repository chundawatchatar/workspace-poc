import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import type { SessionInfo, TermServerMsg } from '@orch/shared'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Terminal } from '@xterm/headless'
import { type Foreground, inspectShells } from './processes.service'

/** One attached browser terminal. Output is held back until its snapshot is sent. */
export interface TermClient {
  /** Bun's result: bytes sent, -1 when buffered under backpressure, 0 when the message was dropped. */
  send(data: string | Uint8Array): number
  /** Bytes the socket has accepted but not yet handed to the network. */
  buffered(): number
  ready: boolean
  queue: Uint8Array[]
  /** Bytes in `queue`. */
  queued: number
  /** It fell behind and skips output until a fresh snapshot brings it back up to date. */
  stale: boolean
  /** The size this view last asked for. */
  want: { cols: number; rows: number } | null
}

const SHELL = process.env.SHELL || '/bin/zsh'

/** Who the user is and how they read text. Everything else comes from their own shell configuration. */
const KEPT_ENV = new Set([
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'TZ',
  'SSH_AUTH_SOCK',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR',
  '__CF_USER_TEXT_ENCODING',
])

/**
 * The environment a new shell starts with. It leaves out whatever the host was
 * launched from (a package script, an agent session, an editor terminal), so
 * agents run in it behave as in the user's own terminal and inherit no tokens.
 */
export function shellEnv(env: Record<string, string | undefined>): Record<string, string> {
  const kept: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && (KEPT_ENV.has(key) || key.startsWith('LC_'))) kept[key] = value
  }
  // `bun run` puts package binaries and its own `node` shim first.
  const path = (env.PATH ?? '')
    .split(':')
    .filter((dir) => dir && !dir.includes('/node_modules/.bin') && !dir.includes('/bun-node-'))
    .join(':')
  if (path) kept.PATH = path
  return { ...kept, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'workspace-poc' }
}
const encoder = new TextEncoder()

/** A client this far behind stops getting output, and is resynced once it drains below `CAUGHT_UP`. */
const BEHIND = 1024 * 1024
const CAUGHT_UP = 128 * 1024

/**
 * Sends one chunk of output to a client, or queues it until its snapshot is
 * sent. A client that falls behind is marked stale instead of buffering
 * without limit: only the current screen matters, so it skips the backlog and
 * gets a new snapshot later.
 */
export function deliver(client: TermClient, data: Uint8Array) {
  if (client.stale) return
  if (!client.ready) {
    client.queue.push(data)
    client.queued += data.byteLength
    if (client.queued > BEHIND) {
      client.queue = []
      client.queued = 0
      client.stale = true
    }
    return
  }
  if (client.buffered() > BEHIND || client.send(data) === 0) client.stale = true
}

/**
 * Reads an OSC 9;4 progress report (`4;<state>;<percent>`), first used by
 * ConEmu and now by tools like Claude Code and Cargo. State 0 clears it, 2 is
 * an error, and the rest (normal, indeterminate, paused) mean busy. Returns
 * undefined for any other OSC 9 payload, which is a notification.
 */
export function parseProgress(data: string): SessionInfo['progress'] | undefined {
  if (data !== '4' && !data.startsWith('4;')) return undefined
  const state = data.split(';')[1] ?? '0'
  if (state === '2') return 'error'
  return state === '' || state === '0' ? null : 'busy'
}

function usableCwd(cwd: string): string {
  try {
    if (cwd && existsSync(cwd) && statSync(cwd).isDirectory()) return cwd
  } catch {}
  return homedir()
}

/**
 * A shell on a pseudo-terminal that outlives any browser connection. A
 * headless terminal mirrors the screen so a client attaching later gets the
 * current state instead of a replay of raw output.
 */
export class Session {
  readonly createdAt = Date.now()
  readonly clients = new Set<TermClient>()
  title = 'Terminal'
  alive = false
  attention: SessionInfo['attention'] = null
  process: SessionInfo['process'] = null
  /** Where the foreground program, or the idle shell, last was. */
  workingDir: string | null = null
  progress: SessionInfo['progress'] = null

  private readonly term: Terminal
  private readonly serializer = new SerializeAddon()
  private proc: Bun.Subprocess | null = null
  /** Runs while a client is stale, to resync it once it has caught up. */
  private resyncTimer: ReturnType<typeof setInterval> | null = null
  /** The view whose size the session follows: the one last typed in or focused. */
  private controller: TermClient | null = null
  private cols: number
  private rows: number

  constructor(
    readonly id: string,
    private readonly cwd: string,
    cols: number,
    rows: number,
    private readonly onChange: (session: Session) => void,
  ) {
    this.cols = cols
    this.rows = rows
    this.term = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true })
    this.term.loadAddon(this.serializer)
    this.term.onTitleChange((title) => {
      if (!title || title === this.title) return
      this.title = title
      this.onChange(this)
    })
    this.term.onBell(() => this.raise('Bell'))
    // Desktop-notification escape sequences that coding agents and scripts emit.
    this.term.parser.registerOscHandler(9, (data) => {
      const progress = parseProgress(data)
      if (progress === undefined) this.raise(data || 'Notification')
      else if (progress !== this.progress) {
        this.progress = progress
        this.onChange(this)
      }
      return true
    })
    this.term.parser.registerOscHandler(777, (data) => {
      const [, title, body] = data.split(';')
      this.raise([title, body].filter(Boolean).join(': ') || 'Notification')
      return true
    })
    this.spawn()
  }

  info(): SessionInfo {
    return {
      id: this.id,
      title: this.title,
      alive: this.alive,
      attention: this.attention,
      process: this.process,
      cwd: this.workingDir,
      progress: this.progress,
    }
  }

  /** The shell's pid, while it runs. */
  get pid(): number | undefined {
    return this.proc?.pid
  }

  /** Records what the shell is running, as last seen by `SessionManager.inspect`. */
  observe(found: (Foreground & { cwd: string | null }) | undefined) {
    const running = found?.busy ? found.process : null
    const process: SessionInfo['process'] = running && {
      pid: running.pid,
      name: running.name,
      command: running.command,
      // Kept from the first sighting, so rounding in `ps` doesn't make it jitter.
      startedAt:
        this.process?.pid === running.pid
          ? this.process.startedAt
          : Math.round(Date.now() / 1000 - running.elapsed) * 1000,
    }
    // A program that exits without clearing its progress would leave the spinner running.
    const progress = process ? this.progress : null
    const workingDir = found?.cwd ?? this.workingDir
    if (
      JSON.stringify([process, workingDir, progress]) === JSON.stringify([this.process, this.workingDir, this.progress])
    )
      return
    this.process = process
    this.workingDir = workingDir
    this.progress = progress
    this.onChange(this)
  }

  private raise(message: string) {
    this.attention = { at: Date.now(), message }
    this.onChange(this)
  }

  ack() {
    if (!this.attention) return
    this.attention = null
    this.onChange(this)
  }

  private spawn() {
    const proc = Bun.spawn([SHELL, '-l'], {
      cwd: usableCwd(this.cwd),
      env: shellEnv(process.env),
      terminal: {
        cols: this.cols,
        rows: this.rows,
        data: (_terminal, data) => this.output(data.slice()),
      },
    })
    this.proc = proc
    this.alive = true
    proc.exited.then((code) => {
      if (this.proc !== proc) return
      this.alive = false
      this.proc = null
      this.process = null
      this.progress = null
      this.output(encoder.encode(`\r\n\x1b[2m[process exited with code ${code} — press Enter to restart]\x1b[0m\r\n`))
      this.onChange(this)
    })
  }

  // Bun's PTY can't pause reading, so a flood of output is never slowed at the
  // source. Clients that can't keep up skip it instead (see `deliver`).
  private output(data: Uint8Array) {
    this.term.write(data)
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

  attach(client: TermClient) {
    this.clients.add(client)
    this.sync(client)
  }

  /** Sends the client the current screen, followed by any output that arrives meanwhile. */
  private sync(client: TermClient) {
    client.ready = false
    client.stale = false
    client.queue = []
    client.queued = 0
    // The empty write is a marker: its callback runs once everything received
    // before it has been applied, so the snapshot and the queued output that
    // follows line up with nothing lost or repeated.
    this.term.write('', () => {
      if (!this.clients.has(client)) return
      const snapshot: TermServerMsg = {
        type: 'snapshot',
        data: this.serializer.serialize(),
        cols: this.cols,
        rows: this.rows,
      }
      client.send(JSON.stringify(snapshot))
      // A client whose queue overflowed stays stale and is resynced again.
      for (const chunk of client.queue) client.send(chunk)
      client.queue = []
      client.queued = 0
      client.ready = true
    })
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
    if (this.alive) {
      this.proc?.terminal?.write(data)
      return
    }
    if (data.includes('\r')) {
      this.output(encoder.encode('\x1bc'))
      this.spawn()
      this.onChange(this)
    }
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

  private apply(cols: number, rows: number) {
    if (cols === this.cols && rows === this.rows) return
    this.cols = cols
    this.rows = rows
    this.term.resize(cols, rows)
    this.proc?.terminal?.resize(cols, rows)
    for (const client of this.clients) this.tell(client)
  }

  private tell(client: TermClient) {
    if (!client.ready) return
    client.send(JSON.stringify({ type: 'size', cols: this.cols, rows: this.rows } satisfies TermServerMsg))
  }

  kill() {
    this.stopResync()
    const proc = this.proc
    this.proc = null
    this.alive = false
    proc?.kill()
    proc?.terminal?.close()
    this.term.dispose()
    this.clients.clear()
  }
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>()

  constructor(
    private readonly onChange: (session: Session) => void,
    private readonly onGone: (id: string) => void,
  ) {}

  get(id: string) {
    return this.sessions.get(id)
  }

  list() {
    return [...this.sessions.values()]
  }

  ensure(id: string, cwd: string, cols: number, rows: number): Session {
    let session = this.sessions.get(id)
    if (!session) {
      session = new Session(id, cwd, cols, rows, this.onChange)
      this.sessions.set(id, session)
      this.onChange(session)
    }
    return session
  }

  /** Ends sessions whose tab no longer exists. New ones get a grace period to appear in the layout. */
  collect(liveIds: Set<string>) {
    for (const [id, session] of this.sessions) {
      if (liveIds.has(id) || Date.now() - session.createdAt < 10_000) continue
      session.kill()
      this.sessions.delete(id)
      this.onGone(id)
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
}
