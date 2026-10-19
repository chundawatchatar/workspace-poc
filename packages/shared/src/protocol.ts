import type { z } from 'zod'
import type { eventsSocket } from './contracts/events'
import type { terminalSocket } from './contracts/terminals'
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
  | { type: 'snapshot'; data: string; cols: number; rows: number }
  | { type: 'size'; cols: number; rows: number }

/** Client to host, on a terminal socket. */
export type TermClientMsg = z.infer<typeof terminalSocket.clientMessage>
