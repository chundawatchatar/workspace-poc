import type { SessionInfo } from '@orch/shared'

/** How close a hook's attention and a terminal signal's must be to count as one. */
export const ATTENTION_MERGE_MS = 2000

/**
 * A session's one attention slot, raised by terminal signals (bell, OSC 9,
 * OSC 777) and by the agent's hooks, which may report the same moment. Within
 * `ATTENTION_MERGE_MS` the two are one attention with the hook's message,
 * since it says why. See "One attention, not two" in `docs/agents.md`.
 */
export class AttentionSlot {
  /** The attention nobody has seen yet; null means none. */
  current: SessionInfo['attention'] = null
  /** When the agent last raised attention, seen or not. */
  private agentAt = Number.NEGATIVE_INFINITY

  /** Raises attention for a terminal signal, unless the agent raised its own just before. Returns whether it changed. */
  signal(message: string, now: number): boolean {
    if (now - this.agentAt < ATTENTION_MERGE_MS) return false
    this.current = { at: now, message }
    return true
  }

  /**
   * Raises attention for the agent. An unseen signal attention from just
   * before takes the agent's message, and keeps its time and its origin, so the
   * state derived from it doesn't change.
   */
  agent(message: string, now: number) {
    this.agentAt = now
    const signal = this.current && !this.current.from ? this.current : null
    this.current =
      signal && now - signal.at < ATTENTION_MERGE_MS ? { at: signal.at, message } : { at: now, message, from: 'agent' }
  }

  /** Returns whether there was attention to clear. */
  clear(): boolean {
    if (!this.current) return false
    this.current = null
    return true
  }
}
