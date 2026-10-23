import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { AgentKind, AgentRef, ProcessInfo } from '@orch/shared'

/** What an adapter needs to know about a running agent to find its conversation. */
export interface AgentProcess {
  pid: number
  cwd: string
  /** When it started, in epoch milliseconds. */
  startedAt: number
}

/**
 * How one coding agent names its program, stores its conversations and resumes
 * one. Ids come from the command line first, since `--resume <id>` is exact,
 * and otherwise from the agent's own files.
 */
export interface AgentAdapter {
  kind: AgentKind
  /**
   * Whether `findSessionId` reads this process's own conversation. Otherwise it picks the newest transcript of the
   * folder, which can't tell two of the agent's processes in one folder apart.
   */
  exact: boolean
  matches(name: string, command: string): boolean
  idFromArgs(argv: string[]): string | null
  /**
   * The conversation the process is in now, which supersedes its arguments once it switches with `/resume`, `/new`
   * or `/clear`. Null when it is known to have none to resume yet, undefined when its files don't tell.
   */
  findSessionId(process: AgentProcess, home: string): string | null | undefined
  /**
   * The command that starts the agent on `sessionId`. Without one, an agent whose conversations are found on disk
   * had not started one yet, so it starts fresh; the others continue their latest conversation in the cwd.
   */
  resumeCommand(sessionId: string | null): string
}

/** Session ids are typed into a shell, so anything beyond these characters is refused. */
const SAFE_ID = /^[\w.:-]{1,128}$/

/** A session file can be created a moment before `ps` reports its process as started, rounded to the second. */
const CLOCK_SLACK = 5000

/** The value after any of `flags`, as `--flag value` or `--flag=value`. */
function flagValue(argv: string[], flags: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    for (const flag of flags) {
      if (argv[i] === flag && argv[i + 1] && !argv[i + 1].startsWith('-')) return argv[i + 1]
      if (argv[i].startsWith(`${flag}=`)) return argv[i].slice(flag.length + 1)
    }
  }
  return null
}

/** The word after a subcommand, as in `codex resume <id>`. */
function subcommandValue(argv: string[], subcommand: string): string | null {
  const index = argv.indexOf(subcommand)
  const value = index === -1 ? undefined : argv[index + 1]
  return value && !value.startsWith('-') ? value : null
}

/** The first line of a file, read without loading the rest of a long transcript. */
function firstLine(file: string): string {
  const fd = openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(64 * 1024)
    const read = readSync(fd, buffer, 0, buffer.length, 0)
    const text = buffer.subarray(0, read).toString()
    const end = text.indexOf('\n')
    return end === -1 ? text : text.slice(0, end)
  } finally {
    closeSync(fd)
  }
}

function safeJson(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text)
    return typeof value === 'object' && value !== null ? value : null
  } catch {
    return null
  }
}

/** `.jsonl` files in `dir` written since the process started, newest first. A missing directory has none. */
function recentTranscripts(dir: string, since: number): string[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((name) => name.endsWith('.jsonl'))
    .flatMap((name) => {
      const file = join(dir, name)
      try {
        const { mtimeMs } = statSync(file)
        return mtimeMs >= since - CLOCK_SLACK ? [{ file, mtimeMs }] : []
      } catch {
        return []
      }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map((entry) => entry.file)
}

/** `YYYY/MM/DD` for each of the last 30 local days, newest first: Codex files sessions by the day they began. */
function recentDays(): string[] {
  const days: string[] = []
  const day = new Date()
  for (let i = 0; i < 30; i++) {
    const pad = (n: number) => String(n).padStart(2, '0')
    days.push(`${day.getFullYear()}/${pad(day.getMonth() + 1)}/${pad(day.getDate())}`)
    day.setDate(day.getDate() - 1)
  }
  return days
}

const claude: AgentAdapter = {
  kind: 'claude',
  exact: true,
  matches: (name) => name === 'claude',
  idFromArgs: (argv) => flagValue(argv, ['--resume', '-r']),
  // Claude Code keeps `sessions/<pid>.json` up to date, including after `/clear` or `/resume` change the conversation.
  // It names the id at startup, but the transcript, which `--resume` needs, is only written with the first message.
  findSessionId({ pid, cwd }, home) {
    try {
      const value = safeJson(readFileSync(join(home, '.claude', 'sessions', `${pid}.json`), 'utf8'))
      if (typeof value?.sessionId !== 'string') return undefined
      const project = (typeof value.cwd === 'string' ? value.cwd : cwd).replace(/[^a-zA-Z0-9]/g, '-')
      return existsSync(join(home, '.claude', 'projects', project, `${value.sessionId}.jsonl`)) ? value.sessionId : null
    } catch {
      return undefined
    }
  },
  resumeCommand: (id) => (id ? `claude --resume ${id}` : 'claude'),
}

const codex: AgentAdapter = {
  kind: 'codex',
  exact: false,
  matches: (name) => name === 'codex',
  idFromArgs: (argv) => subcommandValue(argv, 'resume'),
  // Each conversation is `sessions/YYYY/MM/DD/rollout-*.jsonl`, whose first line names its id and cwd. The file is
  // written with the first message, so before that there is nothing to resume. A resumed conversation keeps
  // appending to the file of the day it began, so older days are searched for files written since the start.
  findSessionId({ cwd, startedAt }, home) {
    for (const day of recentDays()) {
      for (const file of recentTranscripts(join(home, '.codex', 'sessions', day), startedAt)) {
        const meta = safeJson(firstLine(file))
        const payload = meta?.type === 'session_meta' ? (meta.payload as Record<string, unknown>) : null
        if (payload?.cwd === cwd && typeof payload.id === 'string') return payload.id
      }
    }
    return undefined
  },
  resumeCommand: (id) => (id ? `codex resume ${id}` : 'codex'),
}

// OpenCode keeps conversations in a SQLite database, so only an id on the command line is read.
const opencode: AgentAdapter = {
  kind: 'opencode',
  exact: false,
  matches: (name) => name === 'opencode',
  idFromArgs: (argv) => flagValue(argv, ['--session', '-s']),
  findSessionId: () => undefined,
  resumeCommand: (id) => (id ? `opencode --session ${id}` : 'opencode --continue'),
}

// Cursor's chat store is undocumented and changes between releases, so only an id on the command line is read.
const cursor: AgentAdapter = {
  kind: 'cursor',
  exact: false,
  matches: (name, command) => name === 'cursor-agent' || (name === 'agent' && command.includes('cursor')),
  idFromArgs: (argv) => flagValue(argv, ['--resume']),
  findSessionId: () => undefined,
  resumeCommand: (id) => (id ? `cursor-agent --resume ${id}` : 'cursor-agent resume'),
}

const pi: AgentAdapter = {
  kind: 'pi',
  exact: false,
  matches: (name) => name === 'pi',
  idFromArgs: (argv) => flagValue(argv, ['--session']),
  // Conversations are `agent/sessions/--<cwd with dashes>--/<timestamp>_<uuid>.jsonl`.
  findSessionId({ cwd, startedAt }, home) {
    const dir = join(home, '.pi', 'agent', 'sessions', `--${cwd.replace(/^\//, '').replace(/\//g, '-')}--`)
    const file = recentTranscripts(dir, startedAt)[0]
    return (file && basename(file, '.jsonl').split('_').pop()) || undefined
  },
  resumeCommand: (id) => (id ? `pi --session ${id}` : 'pi'),
}

const commandcode: AgentAdapter = {
  kind: 'commandcode',
  exact: false,
  matches: (name) => name === 'cmd' || name === 'commandcode',
  idFromArgs: (argv) => flagValue(argv, ['--session', '--resume', '-r']),
  // Conversations are `projects/<slug>/<id>.jsonl`; the slug's rule is undocumented, so each project is checked.
  findSessionId({ cwd, startedAt }, home) {
    const root = join(home, '.commandcode', 'projects')
    let projects: string[]
    try {
      projects = readdirSync(root)
    } catch {
      return undefined
    }
    for (const project of projects) {
      for (const file of recentTranscripts(join(root, project), startedAt)) {
        if (/\.(checkpoints|prompts)\.jsonl$/.test(file)) continue
        const header = safeJson(firstLine(file))
        if (header && Object.values(header).includes(cwd)) return basename(file, '.jsonl')
      }
    }
    return undefined
  },
  resumeCommand: (id) => (id ? `cmd --session ${id}` : 'cmd'),
}

export const AGENTS: readonly AgentAdapter[] = [claude, codex, opencode, cursor, pi, commandcode]

export function agentAdapter(kind: AgentKind): AgentAdapter | undefined {
  return AGENTS.find((agent) => agent.kind === kind)
}

/** The command that resumes `ref`. An id that is unsafe to type into a shell is treated as no id. */
export function resumeCommand(ref: AgentRef): string | null {
  const adapter = agentAdapter(ref.kind)
  if (!adapter) return null
  return adapter.resumeCommand(ref.sessionId && SAFE_ID.test(ref.sessionId) ? ref.sessionId : null)
}

const RUNTIMES = new Set(['node', 'bun', 'deno'])

/** The program and its arguments. A script run by a runtime, as in `node /usr/local/bin/claude`, is named after it. */
function program({ name, command }: ProcessInfo): { name: string; argv: string[] } {
  const argv = command.split(/\s+/).slice(1)
  const script = RUNTIMES.has(name) ? argv.findIndex((word) => !word.startsWith('-')) : -1
  if (script === -1) return { name, argv }
  return { name: basename(argv[script]).replace(/\.[cm]?js$/, ''), argv: argv.slice(script + 1) }
}

function adapterFor(process: ProcessInfo) {
  const { name, argv } = program(process)
  const adapter = AGENTS.find((agent) => agent.matches(name, process.command))
  return adapter && { adapter, argv }
}

/** The agent `process` is, if any. */
export function agentKind(process: ProcessInfo): AgentKind | null {
  return adapterFor(process)?.adapter.kind ?? null
}

/**
 * Identifies the agent a terminal is running and, when it can be found, the conversation it is in. Pass
 * `guess: false` when another process of the same agent runs in the same folder, so neither takes the other's.
 */
export function detectAgent(process: ProcessInfo, cwd: string | null, home = homedir(), guess = true): AgentRef | null {
  const found = adapterFor(process)
  if (!found || !cwd) return null
  const { adapter, argv } = found
  let current: string | null | undefined
  if (adapter.exact || guess) {
    try {
      current = adapter.findSessionId({ pid: process.pid, cwd, startedAt: process.startedAt }, home)
    } catch {
      current = undefined
    }
  }
  // The arguments only name the conversation the process began in, so they count when its files don't tell.
  const sessionId = current === undefined ? adapter.idFromArgs(argv) : current
  return { kind: adapter.kind, sessionId: sessionId && SAFE_ID.test(sessionId) ? sessionId : null, cwd }
}
