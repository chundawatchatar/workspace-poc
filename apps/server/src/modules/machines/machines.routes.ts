import { schema } from '@orch/domain'
import { serverRoutes } from '@orch/shared'
import { eq } from 'drizzle-orm'
import type { ApiModule } from '../../app'
import { createServerRouter, type UserData } from '../../lib/createServerRouter'
import type { MachineRegistry } from '../tunnel/tunnel.service'
import type { ConnectRequests } from './connect-requests.service'
import {
  acceptConnectRequest,
  type ConnectAnswerDeps,
  createEnrollment,
  listConnectRequests,
  rejectConnectRequest,
} from './enrollment.service'
import { MachinesService } from './machines.service'
import type { RelayTickets } from './relay-ticket.service'

/** What the machines module needs: the registry the tunnel registers connected machines in. */
export interface MachinesModuleDeps {
  registry: MachineRegistry
  /** The connect requests waiting for their owner, which the tunnel's enrollment service holds. */
  requests: ConnectRequests
  /** The clock enrollment keys and requests expire by. Defaults to the current time. */
  now?: () => Date
  /**
   * Signs the relay tickets that open a listed machine without its access key, and holds the public keys a machine
   * gets when its request is accepted.
   */
  relayTickets: Pick<RelayTickets, 'issue' | 'publicKeys'>
  /** `SERVER_TUNNEL_URL`, the address machines open their tunnel to, sent with every new enrollment key. */
  serverTunnelUrl: string
}

/**
 * Builds the module that serves `serverRoutes.machines`: list, rename and
 * unlink the signed-in user's machines, create enrollment keys (each with the
 * server's tunnel address), list, accept and reject the connect requests
 * machines made with them, and sign relay tickets for machines the user lists.
 * It handles machine ids, names, enrollment keys and tickets only, never reads
 * a request header or an access key, and never logs input or a ticket.
 */
export function createMachinesModule({
  registry,
  requests,
  now = () => new Date(),
  relayTickets,
  serverTunnelUrl,
}: MachinesModuleDeps): ApiModule {
  const machinesOf = (data: UserData) => new MachinesService(data.machines, registry)
  const answering = (): ConnectAnswerDeps => ({ requests, registry, relayKeys: relayTickets.publicKeys, now: now() })
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
        createEnrollment: async (_input, { data }) => createEnrollment(data.machineEnrollments, now(), serverTunnelUrl),
        listRequests: async (_input, { data }) => ({ requests: await listConnectRequests(data, requests, now()) }),
        acceptRequest: async ({ id }, { principal, data, fail }) => {
          const answer = await acceptConnectRequest(id, principal, data, answering())
          return typeof answer === 'string' ? fail(answer) : answer
        },
        rejectRequest: async ({ id }, { data, fail }) => {
          const refused = await rejectConnectRequest(id, data, answering())
          if (refused) fail(refused)
          return { ok: true as const }
        },
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
