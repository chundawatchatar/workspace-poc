import type { AgentState, SessionInfo } from '@orch/shared'

/** The terminal signals the baseline reads. An object, so later sources (hooks, the per-session switch) can join it. */
export interface AgentSignals {
  agent: SessionInfo['agent']
  alive: boolean
  interrupted: SessionInfo['interrupted']
  progress: SessionInfo['progress']
  attention: SessionInfo['attention']
}

/**
 * What the agent in the foreground is doing, from the terminal's signals alone (see "Baseline" in `docs/agents.md`).
 * `since` carries over from `previous` while the state name stays the same, so a reason change keeps it.
 */
export function deriveAgentState(signals: AgentSignals, previous: AgentState | null, now: number): AgentState | null {
  if (!signals.agent || signals.interrupted || !signals.alive) return null
  const [state, reason]: [AgentState['state'], AgentState['reason']] =
    signals.progress === 'busy'
      ? ['working', 'progress']
      : signals.attention
        ? ['waiting', 'attention']
        : signals.progress === 'error'
          ? ['idle', 'error']
          : ['idle', 'detected']
  const since = previous?.state === state ? previous.since : now
  return { state, reason, source: 'signals', since }
}
