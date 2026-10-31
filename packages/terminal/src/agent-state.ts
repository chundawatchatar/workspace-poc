import type { AgentReason, AgentState, AgentStateName, SessionInfo } from '@orch/shared'
import type { z } from 'zod'
import { AGENTS, type AgentAdapter } from './agents'
import type { daemonStatus } from './daemon-protocol'

/** How long after `progress` ends with no hook event a hook's `working` gives way to `idle` / `interrupted`. */
export const AGENT_INTERRUPT_MS = 3000

/** The last hook event of the current agent run, kept by the daemon. */
export type AgentHook = NonNullable<z.infer<typeof daemonStatus>['agentHook']>

/** What the state is derived from: the terminal's signals, and the hook state when there is one. */
export interface AgentSignals {
  agent: SessionInfo['agent']
  alive: boolean
  interrupted: SessionInfo['interrupted']
  progress: SessionInfo['progress']
  attention: SessionInfo['attention']
  /** Absent from a daemon that predates the reporting channel. */
  agentHook?: AgentHook | null
  /** When `progress` left `busy`, if it has not been busy since. */
  progressEndedAt?: number | null
}

type Derived = { state: AgentStateName; reason: AgentReason; source: AgentState['source'] }

/** The state from the terminal's signals alone (see "Baseline" in `docs/agents.md`). */
function baseline({ progress, attention }: AgentSignals): Derived {
  if (progress === 'busy') return { state: 'working', reason: 'progress', source: 'signals' }
  if (attention) return { state: 'waiting', reason: 'attention', source: 'signals' }
  if (progress === 'error') return { state: 'idle', reason: 'error', source: 'signals' }
  return { state: 'idle', reason: 'detected', source: 'signals' }
}

/** Applies "Which source wins" in `docs/agents.md`. */
function combine(signals: AgentSignals, now: number, agents: readonly AgentAdapter[]): Derived {
  const base = baseline(signals)
  const hook = signals.agentHook
  if (!hook || hook.agent !== signals.agent?.kind) return base
  const fromHook: Derived = { state: hook.state, reason: hook.reason, source: 'hooks' }
  if (agents.find((agent) => agent.kind === hook.agent)?.tracking?.turnEndOnly) {
    const finished = hook.state === 'idle' && hook.reason === 'finished'
    return !finished || base.state !== 'idle' ? base : fromHook
  }
  const ended = signals.progressEndedAt
  const silent = ended != null && hook.at < ended && now - ended >= AGENT_INTERRUPT_MS
  if (hook.state === 'working' && signals.progress === null && silent) {
    return { state: 'idle', reason: 'interrupted', source: 'signals' }
  }
  return fromHook
}

/**
 * What the agent in the foreground is doing. `since` carries over from
 * `previous` while the state name stays the same, so a reason change keeps it.
 */
export function deriveAgentState(
  signals: AgentSignals,
  previous: AgentState | null,
  now: number,
  agents: readonly AgentAdapter[] = AGENTS,
): AgentState | null {
  if (!signals.agent || signals.interrupted || !signals.alive) return null
  const derived = combine(signals, now, agents)
  return { ...derived, since: previous?.state === derived.state ? previous.since : now }
}
