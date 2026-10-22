import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import type { SessionInfo, TermColors } from '@orch/shared'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Terminal } from '@xterm/headless'
import type { Foreground } from './processes'

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

/**
 * A terminal that can be attached to views, inspected, and explicitly closed.
 * Both backends implement it, so the host does not know who owns the shell.
 */
export interface TerminalSession {
  readonly id: string
  readonly createdAt: number
  readonly pid: number | undefined
  info(): SessionInfo
  observe(found: (Foreground & { cwd: string | null }) | undefined): void
  attach(client: TermClient): void
  detach(client: TermClient): void
  input(data: string, from: TermClient): void
  resize(cols: number, rows: number, from: TermClient): void
  claim(from: TermClient): void
  clear(): void
  ack(): void
  /** The view's theme colours, for a backend that answers colour queries without a browser. */
  colors(palette: TermColors): void
  kill(): void
  shutdown(): void
}

/** Selects the user's shell, with a default available on the current platform. */
export function shellProgram(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
) {
  return env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/sh')
}

const SHELL = shellProgram()

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
export const CAUGHT_UP = 128 * 1024

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
 * A shell on a pseudo-terminal and its mirrored screen, with no opinion about
 * who is watching. The in-process backend fans `onOutput` out to browser views;
 * the daemon backend forwards it over its socket. Both snapshot the same way.
 */
export class TerminalCore {
  readonly createdAt = Date.now()
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
  private cols: number
  private rows: number

  constructor(
    readonly id: string,
    private readonly cwd: string,
    cols: number,
    rows: number,
    private readonly onOutput: (data: Uint8Array) => void,
    private readonly onChange: () => void,
    private readonly shell: string = SHELL,
  ) {
    this.cols = cols
    this.rows = rows
    this.term = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true })
    this.term.loadAddon(this.serializer)
    this.term.onTitleChange((title) => {
      if (!title || title === this.title) return
      this.title = title
      this.onChange()
    })
    this.term.onBell(() => this.raise('Bell'))
    // Desktop-notification escape sequences that coding agents and scripts emit.
    this.term.parser.registerOscHandler(9, (data) => {
      const progress = parseProgress(data)
      if (progress === undefined) this.raise(data || 'Notification')
      else if (progress !== this.progress) {
        this.progress = progress
        this.onChange()
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

  get pid(): number | undefined {
    return this.proc?.pid
  }

  get size(): { cols: number; rows: number } {
    return { cols: this.cols, rows: this.rows }
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
    this.onChange()
  }

  ack() {
    if (!this.attention) return
    this.attention = null
    this.onChange()
  }

  private raise(message: string) {
    this.attention = { at: Date.now(), message }
    this.onChange()
  }

  private spawn() {
    const proc = Bun.spawn([this.shell, '-l'], {
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
      this.onChange()
    })
  }

  // Bun's PTY can't pause reading, so a flood of output is never slowed at the
  // source. Whoever forwards this output skips it for clients that can't keep up.
  private output(data: Uint8Array) {
    this.term.write(data)
    this.onOutput(data)
  }

  /**
   * The screen at a write boundary: the callback runs once everything written
   * before it has been applied, so a snapshot and the output that follows line
   * up with nothing lost or repeated.
   */
  snapshot(): Promise<string> {
    return new Promise((done) => {
      this.term.write('', () => done(this.serializer.serialize()))
    })
  }

  input(data: string) {
    if (this.alive) {
      this.proc?.terminal?.write(data)
      return
    }
    if (data.includes('\r')) {
      this.output(encoder.encode('\x1bc'))
      this.spawn()
      this.onChange()
    }
  }

  resize(cols: number, rows: number) {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2) return
    if (cols === this.cols && rows === this.rows) return
    this.cols = cols
    this.rows = rows
    this.term.resize(cols, rows)
    this.proc?.terminal?.resize(cols, rows)
  }

  /**
   * Clears the screen and scrollback, keeping the current line, as Cmd+K does
   * in macOS terminals. It waits for output already received, so none of it
   * lands after the clear.
   */
  clear(): Promise<void> {
    return new Promise((done) => {
      this.term.write('', () => {
        this.term.clear()
        done()
      })
    })
  }

  kill() {
    const proc = this.proc
    this.proc = null
    this.alive = false
    proc?.kill()
    proc?.terminal?.close()
    this.term.dispose()
  }
}
