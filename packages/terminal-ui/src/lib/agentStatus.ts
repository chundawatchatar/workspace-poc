import {
  AGENT_LABELS,
  type AgentReason,
  type AgentState,
  type AgentStateName,
  listPanes,
  type SessionInfo,
  type Workspace,
} from '@orch/shared'
import { titleSpins } from './agentTitle'

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

/**
 * True when the agent's own spinner leads the title, as Claude Code and Codex
 * draw it during a turn. It counts only for an identified agent with tracking
 * on, in a live session that wasn't interrupted, so a shell left with an exited
 * agent's last title, or a terminal the user switched off, never shows working.
 */
function titleWorking(session: AgentStatusSource) {
  if (!session.agent || session.agentTracking === false || !session.alive || session.interrupted) return false
  return titleSpins(session.title)
}

/** The kind a session shows. `title` is `working` decided by a spinning title alone. */
function statusKind(session: AgentStatusSource): AgentStatusKind | 'title' | null {
  const state = session.agentState?.state
  if (state === 'working' || state === 'waiting') return state
  // Hooks can replace the reason with `finished` while the program still reports the error, so this reads `progress`.
  if (session.progress === 'error') return 'failed'
  // Codex's `notify` reports no turn start, so its spinner outranks the `idle` a hook left from the last turn.
  if (titleWorking(session)) return 'title'
  if (state === 'idle' && session.agentState?.source === 'hooks') return 'idle'
  return session.progress === 'busy' ? 'working' : null
}

/** Decides what a terminal shows about its agent or program. Null means it shows nothing. */
export function agentStatus(session: AgentStatusSource | undefined): AgentStatus | null {
  const decided = session && statusKind(session)
  if (!decided) return null
  const kind = decided === 'title' ? 'working' : decided
  const words = STATE_WORDS[kind]
  const label = session.agent
    ? `${AGENT_LABELS[session.agent.kind]} ${words}`
    : `${words[0].toUpperCase()}${words.slice(1)}`
  // The title overrode the state, so the state's reason and source would describe something else.
  if (decided === 'title') return { kind, label, tooltip: `${label} (title)` }
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

/** How many agents in a workspace are in each state the UI can state. */
export interface AgentStateCounts {
  waiting: number
  working: number
  idle: number
}

/** The state a terminal counts under, or null when it isn't counted. */
function countedState(session: SessionInfo | undefined): AgentStateName | null {
  if (!session) return null
  const state = session.agentState
  if (state?.state === 'working' || state?.state === 'waiting') return state.state
  if (session.progress !== 'error' && titleWorking(session)) return 'working'
  return state?.state === 'idle' && state.source === 'hooks' ? 'idle' : null
}

/**
 * Counts the agents in every terminal of a workspace, in active tabs or not.
 * It reads `agentState` and the agent's spinning title, ranked as `statusKind`
 * ranks them, but not progress alone, which can come from any program. An idle
 * from terminal signals is left out, as `statusKind` does.
 */
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
