import type { z } from 'zod'
import type { eventsSocket } from './contracts/events'
import type { termColors, terminalSocket } from './contracts/terminals'
import type { AppState } from './model'

export const HOST_PORT = 4599
export const WEB_PORT = 3210

export interface HostInfo {
  home: string
  shell: string
  platform: string
  projectRoot: string
}

/** The program a terminal's shell is running in the foreground. */
export interface ProcessInfo {
  pid: number
  /** The program's name, such as `claude` or `vim`. */
  name: string
  /** The full command line. Arguments can hold secrets, so show it only on request. */
  command: string
  /** When it started, in epoch milliseconds. */
  startedAt: number
}

/** The coding agents whose conversations can be found and resumed. */
export type AgentKind = 'claude' | 'codex' | 'opencode' | 'cursor' | 'pi' | 'commandcode'

export const AGENT_LABELS: Record<AgentKind, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  cursor: 'Cursor Agent',
  pi: 'pi',
  commandcode: 'Command Code',
}

/** An agent conversation running in a terminal, as far as it could be identified. */
export interface AgentRef {
  kind: AgentKind
  /** The agent's own session id. Null when only the agent is known, so resuming continues its latest conversation. */
  sessionId: string | null
  /** Where the agent runs, which is where it looks for its conversations. */
  cwd: string
}

export interface SessionInfo {
  id: string
  title: string
  alive: boolean
  /** Set when the session rang the bell or sent a notification nobody has seen. */
  attention: { at: number; message: string } | null
  /** Null while the shell waits at its prompt. */
  process: ProcessInfo | null
  /** The working directory of the foreground program, or of the shell when idle. */
  cwd: string | null
  /** What the program reports with the OSC 9;4 progress sequence. */
  progress: 'busy' | 'error' | null
  /** The agent in the foreground, once identified. */
  agent: AgentRef | null
  /**
   * Set when the terminal daemon lost this session (it restarted or the machine rebooted) while an agent ran in
   * it. Nothing runs until the user resumes the agent or opens a plain shell.
   */
  /** `command` is what Resume runs: the agent on its conversation, or fresh when it had not started one. */
  interrupted: { agent: AgentRef; cwd: string; command: string } | null
}

/** Host to client, on the events socket. */
export type ServerEvent =
  | { type: 'hello'; clientId: string; state: AppState; sessions: SessionInfo[]; info: HostInfo }
  | { type: 'state'; state: AppState }
  | { type: 'session'; session: SessionInfo }
  | { type: 'session.gone'; id: string }

/** Client to host, on the events socket. */
export type ClientEvent = z.infer<typeof eventsSocket.clientMessage>

/** Host to client, on a terminal socket. Terminal output itself travels as binary frames. */
export type TermServerMsg =
  | { type: 'snapshot'; data: string; cols: number; rows: number; serverQueries?: boolean }
  | { type: 'size'; cols: number; rows: number }
  /** Whether this view answers terminal queries. Only one view of a session does, so replies are not doubled. */
  | { type: 'queries'; answer: boolean }

/** Client to host, on a terminal socket. */
export type TermClientMsg = z.infer<typeof terminalSocket.clientMessage>

/** A view's terminal colours, sent so a terminal daemon can answer colour queries. */
export type TermColors = z.infer<typeof termColors>
