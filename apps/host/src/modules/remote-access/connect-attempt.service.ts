import type { ConnectOutcome, ConnectOutcomeKind } from '@orch/shared'
import { OUTCOME_MESSAGES } from './remote-access.errors'

/**
 * One Connect, from its start until the machine is linked or it ends
 * unlinked. It ends once, so an answer, a timer or a lost tunnel that comes
 * after the end changes nothing.
 */
export class ConnectAttempt {
  /** When the server's hold on the request ends, an ISO string on this host's clock. Null until the server holds it. */
  expiresAt: string | null = null
  /** How it ended unlinked. Null while it is on its way or waiting, and once it linked. */
  outcome: ConnectOutcome | null = null
  private done = false
  private timer: Timer | undefined

  /** True once it linked or ended. */
  get ended(): boolean {
    return this.done
  }

  /** The server holds the request for `expiresInMs`, the key's time left; `onExpire` runs then, unless it ended first. */
  wait(expiresInMs: number, onExpire: () => void): void {
    this.expiresAt = new Date(Date.now() + expiresInMs).toISOString()
    this.timer = setTimeout(onExpire, expiresInMs)
  }

  /** Ends it as linked. False when it had already ended. */
  link(): boolean {
    return this.finish()
  }

  /** Ends it unlinked as `kind`, with `message` or the kind's own. False when it had already ended. */
  end(kind: ConnectOutcomeKind, message = OUTCOME_MESSAGES[kind]): boolean {
    if (!this.finish()) return false
    this.outcome = { kind, message }
    return true
  }

  private finish(): boolean {
    if (this.done) return false
    this.done = true
    clearTimeout(this.timer)
    return true
  }
}
