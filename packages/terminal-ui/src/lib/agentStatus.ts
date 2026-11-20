import {
  AGENT_LABELS,
  type AgentReason,
  type AgentState,
  type AgentStateName,
  listPanes,
  type SessionInfo,
  type Workspace,
} from '@orch/shared'

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
export type AgentStatusSource = Pick<
  SessionInfo,
  'progress' | 'agent' | 'title' | 'alive' | 'interrupted' | 'agentTracking'
> & { agentState?: AgentState | null }

const STATE_WORDS: Record<AgentStatusKind, string> = {
  working: 'working',
  waiting: 'waiting for you',
  idle: 'idle',
  failed: 'failed',
}

/** Why the agent is in its state, in the tooltip. */
const REASON_WORDS: Record<AgentReason, string> = {
  ready: 'ready',
  turn: 'running a turn',
  permission: 'needs permission',
  question: 'has a question',
  auth: 'needs you to sign in',
  finished: 'turn finished',
  error: 'reported an error',
}

/**
 * The kind a session shows. With an agent it is the agent's own state, in the
 * standard status: an agent that reports none shows nothing, so a bell, a
 * title or a progress bar never stands in for one. A program with no agent
 * shows its progress, as any terminal would.
 */
function statusKind(session: AgentStatusSource): AgentStatusKind | null {
  if (!session.agent) return session.progress === 'busy' ? 'working' : session.progress === 'error' ? 'failed' : null
  const state = session.agentState
  if (!state) return null
  return state.reason === 'error' ? 'failed' : state.state
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
  return { kind, label, tooltip: state ? `${label}: ${REASON_WORDS[state.reason]}` : label }
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

/** How many agents in a workspace are in each state the UI can state. */
export interface AgentStateCounts {
  waiting: number
  working: number
  idle: number
}

/** The state a terminal counts under, or null when it isn't counted. A failed agent counts as idle. */
function countedState(session: SessionInfo | undefined): AgentStateName | null {
  return session?.agentState?.state ?? null
}

/** Counts the agents in every terminal of a workspace, in active tabs or not, by their own reported state. */
export function agentCounts(workspace: Workspace, sessions: Record<string, SessionInfo>): AgentStateCounts {
  const counts: AgentStateCounts = { waiting: 0, working: 0, idle: 0 }
  const surfaces = listPanes(workspace.root).flatMap((pane) => pane.surfaces)
  for (const surface of surfaces) {
    if (surface.kind !== 'terminal') continue
    const state = countedState(sessions[surface.id])
    if (state) counts[state] += 1
  }
  return counts
}

/** The counts in words, such as `2 agents working, 1 waiting`. Null means there is nothing to count. */
export function agentCountsLabel(counts: AgentStateCounts) {
  const parts = (['working', 'waiting', 'idle'] as const).filter((state) => counts[state] > 0)
  if (parts.length === 0) return null
  return parts
    .map((state, index) => {
      if (index > 0) return `${counts[state]} ${state}`
      return `${counts[state]} ${counts[state] === 1 ? 'agent' : 'agents'} ${state}`
    })
    .join(', ')
}
