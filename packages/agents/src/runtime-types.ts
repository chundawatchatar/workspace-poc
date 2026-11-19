import type { AgentKind } from './registry'

/** A file an agent needs under `<runtime>/agent/`, beside its shim. */
export interface AgentTrackerFile {
  name: string
  contents: string
  mode: number
}

/**
 * Everything tracking needs from one agent. Its adapter supplies the native
 * scripts; its definition advertises the capability to the browser.
 */
export interface AgentTracker {
  /** The name on `PATH` and the file in `bin/`. It can differ from the agent's kind, which is what events name. */
  program: string
  /** The shim's script, which starts with `shimStart`. */
  shim: string
  /**
   * The `case` arm of `orch-agent-hook`, named after the kind. It sets `agent`, `state` and `reason` to values from
   * fixed lists, never to free text, and leaves in the arguments only a program to run after the report.
   */
  hookBranch: string
  /** Files written with the shim. */
  files?: AgentTrackerFile[]
  /** The agent only reports that a turn ended, so the baseline says what happens during one. */
  turnEndOnly?: boolean
}

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
  resumeCommand?(sessionId: string | null): string
  /** How to attach to the agent's own events. Without it, only the terminal's signals say what it is doing. */
  tracking?: AgentTracker
}
