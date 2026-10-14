import type { AppState } from './model'

export const HOST_PORT = 4599
export const WEB_PORT = 3210

export interface HostInfo {
  home: string
  shell: string
  platform: string
  projectRoot: string
}

export interface SessionInfo {
  id: string
  title: string
  alive: boolean
  /** Set when the session rang the bell or sent a notification nobody has seen. */
  attention: { at: number; message: string } | null
}

/** Host to client, on the events socket. */
export type ServerEvent =
  | { type: 'hello'; clientId: string; state: AppState; sessions: SessionInfo[]; info: HostInfo }
  | { type: 'state'; state: AppState }
  | { type: 'session'; session: SessionInfo }
  | { type: 'session.gone'; id: string }

/** Client to host, on the events socket. */
export type ClientEvent = { type: 'state'; state: AppState } | { type: 'ack'; sessionId: string }

/** Host to client, on a terminal socket. Terminal output itself travels as binary frames. */
export type TermServerMsg =
  | { type: 'snapshot'; data: string; cols: number; rows: number }
  | { type: 'size'; cols: number; rows: number }

/** Client to host, on a terminal socket. */
export type TermClientMsg =
  | { type: 'input'; data: string }
  /** The size this view's pane can show. The host applies it only for the view in control. */
  | { type: 'resize'; cols: number; rows: number }
  /** This view was focused, so the session should take its size. */
  | { type: 'focus' }

export interface GitInfo {
  branch: string | null
  changes: number
}
