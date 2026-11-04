import { schema } from '@orch/domain'
import { eq } from 'drizzle-orm'
import type { Context } from 'hono'
import type { Authenticate, ForUser } from '../../lib/createServerRouter'

/**
 * The user id to attach to a request relayed to `machineId`, read from the
 * outer request's session. Null means nothing is attached. It never rejects.
 */
export type RelayAccount = (c: Context, machineId: string) => Promise<string | null>

/** What the resolver is built from: the same `authenticate` and `forUser` the server API uses. */
export interface RelayAccountDeps {
  authenticate: Authenticate
  forUser: ForUser
}

/**
 * Builds the `RelayAccount` the relay routes call once per HTTP request and
 * once per socket upgrade. It answers the signed-in user's id only when their
 * own machine list holds `machineId`, so a user id is never sent to a machine
 * the user doesn't list. The machine still compares it with the account it is
 * linked to, which is the real check. Nobody signed in, an unlisted machine
 * and a failed session or machine lookup all answer null, and nothing about
 * the session or the account is logged.
 */
export function createRelayAccount({ authenticate, forUser }: RelayAccountDeps): RelayAccount {
  return async (c, machineId) => {
    try {
      const principal = await authenticate(c)
      if (!principal) return null
      const listed = await forUser(principal).machines.find(eq(schema.machines.machineId, machineId))
      return listed ? principal.userId : null
    } catch {
      return null
    }
  }
}
