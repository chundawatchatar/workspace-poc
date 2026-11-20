/**
 * The one status every agent shows, read from the Program Status Protocol (OSC
 * 7501) the agent writes into its own terminal. It is the same for every agent:
 * nothing here is per agent, and an agent that doesn't speak the protocol shows
 * no status. See "Agent status" in `docs/agents.md`.
 */

/** What the agent is doing: running a turn, waiting for the user, or at rest. */
export const AGENT_STATES = ['working', 'waiting', 'idle'] as const

/**
 * Why. Each is a fixed word, so a report never carries a prompt, a path or any
 * text from the terminal (SEC-3). `waiting` is `permission`, `question` or
 * `auth`; `idle` is `ready`, `finished` or `error`; `working` is `turn`.
 */
export const AGENT_REASONS = ['ready', 'turn', 'permission', 'question', 'auth', 'finished', 'error'] as const

export type AgentStateName = (typeof AGENT_STATES)[number]
export type AgentReason = (typeof AGENT_REASONS)[number]

/** One report in the standard status. `waiting` means the agent can't go on until the user answers. */
export interface AgentReport {
  state: AgentStateName
  reason: AgentReason
}
