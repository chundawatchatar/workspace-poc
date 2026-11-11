import type { ForUser } from '../../lib/createServerRouter'
import type { MachineRegistry } from '../tunnel/tunnel.service'

/** What `SessionEnded` needs: the scoped repositories and the one registry of live tunnels. */
export interface SessionEndedDeps {
  forUser: ForUser
  registry: MachineRegistry
}

/**
 * Tells a user's online machines that one of the user's sessions ended, so
 * each closes the sockets the account's relay tickets opened. The frame names
 * only the account; the machine decides what to do with it.
 */
export class SessionEnded {
  constructor(private readonly deps: SessionEndedDeps) {}

  /**
   * Sends `session.ended` for `userId` to each of the user's machines that has
   * a live tunnel. It never rejects: a failure is logged as one fixed line,
   * without the user id, so the sign-out that caused it is never affected.
   */
  async ended(userId: string): Promise<void> {
    try {
      const machines = await this.deps.forUser({ userId }).machines.list()
      for (const { machineId } of machines) {
        this.deps.registry.get(machineId)?.send({ type: 'session.ended', accountId: userId })
      }
    } catch {
      console.error('could not tell machines that a session ended')
    }
  }
}
