import { serverRoutes } from '@orch/shared'
import type { ApiModule } from '../../app'
import { createServerRouter, type UserData } from '../../lib/createServerRouter'
import type { MachineRegistry } from '../tunnel/tunnel.service'
import { MachinesService } from './machines.service'

/** What the machines module needs: the registry the tunnel registers connected machines in. */
export interface MachinesModuleDeps {
  registry: MachineRegistry
}

/**
 * Builds the module that serves `serverRoutes.machines`: list, link, rename
 * and unlink the signed-in user's machines. It handles machine ids and names
 * only, never reads a request header or an access key, and never logs input.
 */
export function createMachinesModule({ registry }: MachinesModuleDeps): ApiModule {
  const machinesOf = (data: UserData) => new MachinesService(data.machines, registry)
  return (options) =>
    createServerRouter(
      serverRoutes.machines,
      {
        list: async (_input, { data }) => ({ machines: await machinesOf(data).list() }),
        link: async ({ machineId, name }, { data }) => machinesOf(data).link(machineId, name),
        rename: async ({ machineId, name }, { data, fail }) =>
          (await machinesOf(data).rename(machineId, name)) ?? fail('not_found'),
        unlink: async ({ machineId }, { data, fail }) => {
          if (!(await machinesOf(data).unlink(machineId))) fail('not_found')
          return { ok: true as const }
        },
      },
      options,
    )
}
