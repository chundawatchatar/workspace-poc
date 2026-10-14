import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import type { SessionInfo, TermServerMsg } from '@poc/shared'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Terminal } from '@xterm/headless'

/** One attached browser terminal. Output is held back until its snapshot is sent. */
export interface TermClient {
  send(data: string | Uint8Array): void
  ready: boolean
  queue: Uint8Array[]
  /** The size this view last asked for. */
  want: { cols: number; rows: number } | null
}

const SHELL = process.env.SHELL || '/bin/zsh'
const encoder = new TextEncoder()

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

  private readonly term: Terminal
  private readonly serializer = new SerializeAddon()
  private proc: Bun.Subprocess | null = null
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
      this.raise(data || 'Notification')
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
    return { id: this.id, title: this.title, alive: this.alive, attention: this.attention }
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
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'workspace-poc' },
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
      this.output(encoder.encode(`\r\n\x1b[2m[process exited with code ${code} — press Enter to restart]\x1b[0m\r\n`))
      this.onChange(this)
    })
  }

  private output(data: Uint8Array) {
    this.term.write(data)
    for (const client of this.clients) {
      if (client.ready) client.send(data)
      else client.queue.push(data)
    }
  }

  attach(client: TermClient) {
    this.clients.add(client)
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
      for (const chunk of client.queue) client.send(chunk)
      client.queue = []
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

  killAll() {
    for (const session of this.sessions.values()) session.kill()
    this.sessions.clear()
  }
}
