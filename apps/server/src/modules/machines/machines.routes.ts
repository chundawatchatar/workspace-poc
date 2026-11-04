import { schema } from '@orch/domain'
import { serverRoutes } from '@orch/shared'
import { eq } from 'drizzle-orm'
import type { ApiModule } from '../../app'
import { createServerRouter, type UserData } from '../../lib/createServerRouter'
import type { MachineRegistry } from '../tunnel/tunnel.service'
import { createEnrollment } from './enrollment.service'
import { MachinesService } from './machines.service'
import type { RelayTickets } from './relay-ticket.service'

/** What the machines module needs: the registry the tunnel registers connected machines in. */
export interface MachinesModuleDeps {
  registry: MachineRegistry
  /** The clock enrollment keys expire by. Defaults to the current time. */
  now?: () => Date
  /** Signs the relay tickets that open a listed machine without its access key. */
  relayTickets: Pick<RelayTickets, 'issue'>
}

/**
 * Builds the module that serves `serverRoutes.machines`: list, rename and
 * unlink the signed-in user's machines, create enrollment keys, and sign relay
 * tickets for machines the user lists. It handles machine ids, names,
 * enrollment keys and tickets only, never reads a request header or an access
 * key, and never logs input or a ticket.
 */
export function createMachinesModule({
  registry,
  now = () => new Date(),
  relayTickets,
}: MachinesModuleDeps): ApiModule {
  const machinesOf = (data: UserData) => new MachinesService(data.machines, registry)
  return (options) =>
    createServerRouter(
      serverRoutes.machines,
      {
        list: async (_input, { data }) => ({ machines: await machinesOf(data).list() }),
        rename: async ({ machineId, name }, { data, fail }) =>
          (await machinesOf(data).rename(machineId, name)) ?? fail('not_found'),
        unlink: async ({ machineId }, { data, fail }) => {
          if (!(await machinesOf(data).unlink(machineId))) fail('not_found')
          return { ok: true as const }
        },
        createEnrollment: async (_input, { data }) => createEnrollment(data.machineEnrollments, now()),
        // Only the user's own scoped list can hold the machine, so a ticket never names a machine the user doesn't
        // list. The machine still checks that the ticket's account is the one it linked.
        relayTicket: async ({ machineId }, { principal, data, fail }) => {
          const listed = await data.machines.find(eq(schema.machines.machineId, machineId))
          if (!listed) fail('not_found')
          return relayTickets.issue(principal.userId, machineId)
        },
      },
      options,
    )
}
