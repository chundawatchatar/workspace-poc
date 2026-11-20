import type { AgentState, SessionInfo } from '@orch/shared'
import type { AgentReportAt } from './agent-reports'

/** What the state is derived from: the agent in the foreground, and what its program last reported. */
export interface AgentSignals {
  agent: SessionInfo['agent']
  alive: boolean
  interrupted: SessionInfo['interrupted']
  agentReport: AgentReportAt | null
}

/**
 * What the agent in the foreground is doing: what it last reported, in the
 * standard status. With no agent detected, or an agent that reports nothing,
 * there is no state; a bell, a title or a progress bar never stands in for one.
 * `since` carries over from `previous` while the state name stays the same.
 */
export function deriveAgentState(signals: AgentSignals, previous: AgentState | null, now: number): AgentState | null {
  const { agent, alive, interrupted, agentReport } = signals
  if (!agent || interrupted || !alive || !agentReport) return null
  const { state, reason } = agentReport
  return { state, reason, since: previous?.state === state ? previous.since : now }
}
