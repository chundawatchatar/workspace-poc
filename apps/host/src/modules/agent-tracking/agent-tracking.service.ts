import type { AgentTrackingStatus, TrackedAgent, UpdateAgentTrackingBody } from '@orch/shared'
import { type AgentTracking, type TrackedAgentKind, trackedKinds } from '@orch/terminal'
import type { AgentTrackingRepository } from './agent-tracking.repository'

// The contract's agents and the kinds the terminal package tracks must be the same list; this fails to compile
// when one gains a kind the other lacks.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never
const sameKinds: Same<TrackedAgent, TrackedAgentKind> = true
void sameKinds

/** The user's trust answers per agent kind, and what they mean for the daemon. */
export class AgentTrackingService {
  private answers: AgentTrackingStatus
  private readonly listeners = new Set<() => void>()

  constructor(private readonly repository: AgentTrackingRepository) {
    this.answers = repository.load()
  }

  /** The answers as stored; null for a kind never asked. */
  status(): AgentTrackingStatus {
    return { ...this.answers }
  }

  /** Stores one answer and tells the listeners when it changed. */
  update({ agent, answer }: UpdateAgentTrackingBody): AgentTrackingStatus {
    if (this.answers[agent] === answer) return this.status()
    const next = { ...this.answers, [agent]: answer }
    this.repository.save(next)
    this.answers = next
    for (const listener of this.listeners) listener()
    return this.status()
  }

  /** Which agents a terminal may track: only those the user answered Track for. */
  tracking(): AgentTracking {
    return Object.fromEntries(trackedKinds().map((kind) => [kind, this.answers[kind] === 'on'])) as AgentTracking
  }

  /** Calls `listener` after every changed answer. Returns a function that stops it. */
  onChange(listener: () => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
