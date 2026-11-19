import type { HookAgentKind } from '../registry'

/** The states an agent's native hooks can report. */
export const AGENT_HOOK_STATES = ['working', 'waiting', 'idle'] as const

/** The fixed reasons accepted from native hooks, including the event that ends a run. */
export const AGENT_HOOK_REASONS = ['started', 'prompt', 'tool', 'permission', 'question', 'finished', 'exited'] as const

/** The reasons retained in daemon status; exiting clears the hook state instead. */
export const STORED_AGENT_HOOK_REASONS = AGENT_HOOK_REASONS.filter((reason) => reason !== 'exited')

/** A fixed hook report; native payloads stay inside the agent's own integration. */
export interface AgentHookEvent {
  agent: HookAgentKind
  state: (typeof AGENT_HOOK_STATES)[number]
  reason: (typeof AGENT_HOOK_REASONS)[number]
}
