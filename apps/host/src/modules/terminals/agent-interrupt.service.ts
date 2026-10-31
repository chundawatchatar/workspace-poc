import type { SessionInfo } from '@orch/shared'
import { AGENT_INTERRUPT_MS } from '@orch/terminal'

/**
 * Remembers when a session's `progress` left `busy`, for the `interrupted` rule
 * in `deriveAgentState`, and calls `onDue` once that rule's wait is over, since
 * nothing else would recompute the state then.
 */
export class ProgressWatch {
  /** When `progress` left `busy` and has not been busy since. Null otherwise. */
  endedAt: number | null = null
  /** The last `progress` heard, kept here because reconnects clear the session's status. */
  private last: SessionInfo['progress'] = null
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly onDue: () => void) {}

  note(progress: SessionInfo['progress']) {
    const ended = this.last === 'busy' && progress === null
    this.last = progress
    if (progress === 'busy') {
      this.endedAt = null
      this.stop()
    }
    if (!ended) return
    this.endedAt = Date.now()
    this.stop()
    // A moment past the wait, so the clock has reached it when the state is computed.
    this.timer = setTimeout(this.onDue, AGENT_INTERRUPT_MS + 5)
    this.timer.unref()
  }

  stop() {
    clearTimeout(this.timer)
  }
}
