import type { AgentKind } from './registry'

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
