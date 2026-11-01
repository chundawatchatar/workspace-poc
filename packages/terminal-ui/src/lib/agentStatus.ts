import { AGENT_LABELS, type AgentReason, type AgentState, type SessionInfo } from '@orch/shared'

export type AgentStatusKind = 'working' | 'waiting' | 'idle' | 'failed'

/** What a tab or sidebar row shows about the program in a terminal. */
export interface AgentStatus {
  kind: AgentStatusKind
  /** The accessible name of the mark, such as `Codex waiting for you`. */
  label: string
  /** The label with the reason and source, for the tooltip. */
  tooltip: string
}

/** The session fields the status comes from. A host older than `agentState` leaves it out. */
export type AgentStatusSource = Pick<SessionInfo, 'progress' | 'agent'> & { agentState?: AgentState | null }

const STATE_WORDS: Record<AgentStatusKind, string> = {
  working: 'working',
  waiting: 'waiting for you',
  idle: 'idle',
  failed: 'failed',
}

/** Why the agent is in its state, in the tooltip. Empty adds no reason text. */
const REASON_WORDS: Record<AgentReason, string> = {
  started: 'session started',
  prompt: 'prompt submitted',
  tool: 'using a tool',
  permission: 'needs permission',
  question: 'has a question',
  finished: 'turn finished',
  progress: 'reporting progress',
  attention: 'asked for attention',
  error: 'reported an error',
  interrupted: 'interrupted',
  detected: '',
}

const SOURCE_WORDS: Record<AgentState['source'], string> = {
  hooks: 'agent hooks',
  signals: 'terminal signals',
}

function statusKind(session: AgentStatusSource): AgentStatusKind | null {
  const state = session.agentState?.state
  if (state === 'working' || state === 'waiting') return state
  // Hooks can replace the reason with `finished` while the program still reports the error, so this reads `progress`.
  if (session.progress === 'error') return 'failed'
  if (state === 'idle') return 'idle'
  return session.progress === 'busy' ? 'working' : null
}

/** Decides what a terminal shows about its agent or program. Null means it shows nothing. */
export function agentStatus(session: AgentStatusSource | undefined): AgentStatus | null {
  const kind = session && statusKind(session)
  if (!kind) return null
  const words = STATE_WORDS[kind]
  const label = session.agent
    ? `${AGENT_LABELS[session.agent.kind]} ${words}`
    : `${words[0].toUpperCase()}${words.slice(1)}`
  const state = session.agentState
  if (!state) return { kind, label, tooltip: label }
  const reason = REASON_WORDS[state.reason]
  return { kind, label, tooltip: `${label}${reason && `: ${reason}`} (${SOURCE_WORDS[state.source]})` }
}

/** Adds a status to the tooltip a tab or row already has. */
export function withStatus(tooltip: string, status: AgentStatus | null) {
  return status ? `${tooltip}\n${status.tooltip}` : tooltip
}

export type SidebarSignal = 'status' | 'attention' | 'interrupted' | 'running' | 'exited' | 'shell'

/** The one signal a sidebar row has room for. An unseen notification outranks an idle agent, not an active one. */
export function sidebarSignal(
  session: Pick<SessionInfo, 'attention' | 'interrupted' | 'process' | 'alive'> | undefined,
  status: AgentStatus | null,
): SidebarSignal {
  if (status && status.kind !== 'idle') return 'status'
  if (session?.attention) return 'attention'
  if (status) return 'status'
  if (session?.interrupted) return 'interrupted'
  if (session?.process) return 'running'
  return session && !session.alive ? 'exited' : 'shell'
}
