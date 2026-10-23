import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import type { AgentRef, SessionInfo, TermColors, TermServerMsg } from '@orch/shared'
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
  /** This view answers terminal queries. Exactly one attached view does; see `assignResponder`. */
  answers: boolean
}

/**
 * Picks the one view that answers terminal queries (device attributes, cursor
 * position, colours): the controller, or else any attached view. Every view's
 * xterm would otherwise answer, and the program would read each reply as
 * typed input. Views that are ready are told at once; one waiting for its
 * snapshot learns it from the snapshot. Returns whether any view answers.
 */
export function assignResponder(clients: ReadonlySet<TermClient>, controller: TermClient | null): boolean {
  const responder = controller && clients.has(controller) ? controller : (clients.values().next().value ?? null)
  for (const client of clients) {
    const answers = client === responder
    if (client.answers === answers) continue
    client.answers = answers
    if (client.ready) client.send(JSON.stringify({ type: 'queries', answer: answers } satisfies TermServerMsg))
  }
  return responder !== null
}

/**
 * A terminal that can be attached to views, inspected, and explicitly closed.
 * The host implements it over the daemon socket; `SessionManager` keeps one per tab.
 */
export interface TerminalSession {
  readonly id: string
  readonly createdAt: number
  readonly pid: number | undefined
  info(): SessionInfo
  observe(found: (Foreground & { cwd: string | null }) | undefined): void
  /**
   * The agent in the foreground as last identified by `SessionManager.inspect`, or null when there is none.
   * `ambiguous` means another of its kind runs in the same folder, so a missing conversation id is unknown, not none.
   */
  observeAgent(agent: AgentRef | null, ambiguous: boolean): void
  /** Starts an interrupted terminal again: its agent on the saved conversation, or a plain shell. */
  restore(mode: 'agent' | 'shell'): void
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
 * Private modes xterm's serialize addon does not restore. Mouse encoding and
 * alternate scroll are the ones a full-screen agent needs: without them the
 * browser sends wheel events in the wrong format, or not at all.
 */
export const TRACKED_MODES = new Set([25, 1005, 1006, 1007, 1016])

/**
 * The tracked private modes as `CSI ? n h`/`l`, and the cursor shape as DECSCUSR
 * (`CSI Ps SP q`), to append to a serialized snapshot.
 */
export function modesTail(modes: ReadonlyMap<number, boolean>, cursorStyle: number | null = null): string {
  let out = ''
  for (const [code, on] of modes) out += `\x1b[?${code}${on ? 'h' : 'l'}`
  if (cursorStyle !== null) out += `\x1b[${cursorStyle} q`
  return out
}

/** The 256-colour palette entry xterm uses when a theme does not set it: the 6×6×6 cube, then 24 greys. */
export function defaultColor(index: number): string | null {
  if (index >= 16 && index < 232) {
    const level = (n: number) => (n === 0 ? 0 : 55 + n * 40)
    const n = index - 16
    return rgbHex(level(Math.floor(n / 36)), level(Math.floor(n / 6) % 6), level(n % 6))
  }
  if (index >= 232 && index < 256) {
    const grey = 8 + (index - 232) * 10
    return rgbHex(grey, grey, grey)
  }
  return null
}

function rgbHex(r: number, g: number, b: number) {
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`
}

/** `#rrggbb` as the X11 `rgb:rrrr/gggg/bbbb` that OSC colour replies use. */
export function x11Color(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((at) => hex.slice(at, at + 2).repeat(2))
  return `rgb:${r}/${g}/${b}`
}

/**
 * The replies to OSC 4/10/11/12 colour queries (`?`), from the view's theme.
 * Entries the theme does not give are left unanswered rather than guessed.
 */
export function colorReplies(code: number, data: string, palette: TermColors): string[] {
  const reply = (body: string) => `\x1b]${body}\x1b\\`
  const parts = data.split(';')
  if (code === 4) {
    const out: string[] = []
    for (let at = 0; at + 1 < parts.length; at += 2) {
      const index = Number(parts[at])
      if (parts[at + 1] !== '?' || !Number.isInteger(index)) continue
      const color = index < 16 ? palette.ansi?.[index] : defaultColor(index)
      if (color) out.push(reply(`4;${index};${x11Color(color)}`))
    }
    return out
  }
  // OSC 10 may ask for the following dynamic colours too: `10;?;?` is foreground then background.
  const dynamic = [palette.foreground, palette.background, palette.cursor]
  return parts.flatMap((part, offset) => {
    const color = dynamic[code - 10 + offset]
    return part === '?' && color ? [reply(`${code + offset};${x11Color(color)}`)] : []
  })
}

/**
 * A DECSTBM sequence (`CSI Pt ; Pb r`) as a 0-based scrolling region, or null
 * when the bounds are invalid and xterm would ignore the sequence. A missing or
 * zero bound means the default: the first and last row.
 */
export function scrollRegion(params: (number | number[])[], rows: number): { top: number; bottom: number } | null {
  const first = typeof params[0] === 'number' && params[0] > 0 ? params[0] : 1
  const last = typeof params[1] === 'number' && params[1] > 0 ? params[1] : rows
  return first < last ? { top: first - 1, bottom: last - 1 } : null
}

/**
 * The state a reconnecting view needs but the serialize addon does not restore:
 * the scrolling region, and the cursor it moves when the region is set. Returns
 * escape sequences to append to a serialized snapshot.
 */
export function scrollRegionTail(term: Terminal, region: { top: number; bottom: number } | null): string {
  const rows = term.rows
  const top = region ? Math.max(0, Math.min(region.top, rows - 1)) : 0
  const bottom = region ? Math.max(top, Math.min(region.bottom, rows - 1)) : rows - 1
  const active = term.buffer.active
  const origin = term.modes.originMode
  const restored = top !== 0 || bottom !== rows - 1 ? `\x1b[${top + 1};${bottom + 1}r` : ''
  // Output that ended at the right margin leaves a wrap pending, which the serialized cursor keeps but a cursor
  // move would cancel. A restored region or origin mode (whose sequence in the snapshot homes the cursor) needs
  // the move anyway, and then the next character overwrites.
  if (!restored && !origin && active.cursorX >= term.cols) return ''
  const row = origin ? Math.max(0, active.cursorY - top) : active.cursorY
  return `${restored}\x1b[${row + 1};${Math.min(active.cursorX, term.cols - 1) + 1}H`
}

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
 * who is watching. The daemon owns one per terminal and forwards `onOutput`
 * over its socket to the host.
 */
export class TerminalCore {
  readonly createdAt = Date.now()
  title = 'Terminal'
  alive = false
  attention: SessionInfo['attention'] = null
  progress: SessionInfo['progress'] = null

  private readonly term: Terminal
  private readonly serializer = new SerializeAddon()
  private proc: Bun.Subprocess | null = null
  private cols: number
  private rows: number
  /** The scrolling region, which xterm resets on resize and the serialize addon does not restore. */
  private region: { top: number; bottom: number } | null = null
  /** The private modes from `TRACKED_MODES` the program has set or reset. */
  private readonly modes = new Map<number, boolean>()
  /** The cursor shape last set with DECSCUSR, which the serialize addon does not restore. */
  private cursorStyle: number | null = null
  /**
   * Whether this core answers terminal queries itself. It does only while no
   * view is attached; otherwise one view answers, so a reply is never doubled.
   */
  private answering = false
  /** The attached views' theme, for answering colour queries while none is attached. */
  private palette: TermColors | null = null
  private lastRedraw = 0

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
    // Full-screen programs scroll a fixed region and keep a status line outside it. xterm's serialize
    // addon drops the region, so a reconnecting view would scroll the whole screen. Track it to re-apply.
    this.term.parser.registerCsiHandler({ final: 'r' }, (params) => {
      const region = scrollRegion(params, this.rows)
      if (region) this.region = region
      return false
    })
    this.term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
      for (const code of params) if (typeof code === 'number' && TRACKED_MODES.has(code)) this.modes.set(code, true)
      return false
    })
    this.term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
      for (const code of params) if (typeof code === 'number' && TRACKED_MODES.has(code)) this.modes.set(code, false)
      return false
    })
    this.term.parser.registerCsiHandler({ intermediates: ' ', final: 'q' }, (params) => {
      const style = typeof params[0] === 'number' ? params[0] : 0
      this.cursorStyle = style >= 0 && style <= 6 ? style : this.cursorStyle
      return false
    })
    // A full reset (RIS, also sent when the shell restarts) and a soft reset (DECSTR) drop the region and modes.
    const reset = () => {
      this.region = null
      this.modes.clear()
      this.cursorStyle = null
      return false
    }
    this.term.parser.registerEscHandler({ final: 'c' }, reset)
    this.term.parser.registerCsiHandler({ intermediates: '!', final: 'p' }, reset)
    // xterm answers device, cursor and mode queries through onData; pass them on only while no view answers.
    this.term.onData((reply) => {
      if (this.answering) this.proc?.terminal?.write(reply)
    })
    // The headless terminal has no theme, so colour queries are answered here from the views' palette.
    for (const code of [4, 10, 11, 12]) {
      this.term.parser.registerOscHandler(code, (data) => {
        if (this.answering && this.palette) {
          for (const reply of colorReplies(code, data, this.palette)) this.proc?.terminal?.write(reply)
        }
        return false
      })
    }
    this.spawn()
  }

  get pid(): number | undefined {
    return this.proc?.pid
  }

  get size(): { cols: number; rows: number } {
    return { cols: this.cols, rows: this.rows }
  }

  /** What the daemon reports in its status. The host adds what it inspects itself, such as the foreground program. */
  info(): Pick<SessionInfo, 'id' | 'title' | 'alive' | 'attention' | 'progress'> {
    return { id: this.id, title: this.title, alive: this.alive, attention: this.attention, progress: this.progress }
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
      this.term.write('', () =>
        done(
          this.serializer.serialize() +
            modesTail(this.modes, this.cursorStyle) +
            scrollRegionTail(this.term, this.region),
        ),
      )
    })
  }

  /** Answer queries here (no view is attached) or leave them to the one view that answers. */
  answerQueries(on: boolean) {
    this.answering = on
  }

  /** The views' theme, used for colour queries answered while no view is attached. */
  setPalette(palette: TermColors) {
    this.palette = palette
  }

  /**
   * Makes a full-screen program repaint itself for a view that just attached.
   * A snapshot cannot capture everything such a program assumes about the
   * screen, but its own redraw is always right. The PTY briefly shrinks by one
   * row, so the program gets two SIGWINCHes and draws at the real size last.
   * The shell's own screen is left alone: a resize there would reflow history.
   */
  /** Clears the progress a program left behind when it exited without clearing it, which would spin forever. */
  idle() {
    if (this.progress === null) return
    this.progress = null
    this.onChange()
  }

  redraw() {
    const terminal = this.proc?.terminal
    if (!terminal || !this.alive || this.term.buffer.active.type !== 'alternate') return
    if (Date.now() - this.lastRedraw < 1000) return
    this.lastRedraw = Date.now()
    const { cols, rows } = this
    terminal.resize(cols, rows - 1)
    setTimeout(() => {
      // A real resize in the meantime already set the size.
      if (this.proc?.terminal === terminal && this.cols === cols && this.rows === rows) terminal.resize(cols, rows)
    }, 30)
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
    // xterm resets the scrolling region on resize, so forget it until the program sets one again.
    this.region = null
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
