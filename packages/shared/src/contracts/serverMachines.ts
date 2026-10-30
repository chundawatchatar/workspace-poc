import { z } from 'zod'
import { defineServerContract } from './server'

// The machines linked to an account. The accounts API only ever handles machine ids and names: no schema here has a
// key field, and every input is strict, so a body that carries a key is refused rather than silently dropped.

/** A machine's id, as the relay derives it from the machine's secret: unpadded base64url SHA-256, 43 characters. */
export const machineIdSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'Not a machine id.')

/** A machine's name as the user sees it, trimmed, 1 to 64 characters. */
export const machineNameSchema = z.string().trim().min(1).max(64)

/** A machine linked to the signed-in account. Dates are ISO strings. */
export const serverMachine = z.object({
  machineId: z.string(),
  name: z.string(),
  createdAt: z.iso.datetime(),
  /** When the machine was last linked or opened through a connect link. */
  lastOpenedAt: z.iso.datetime(),
  /** True when the machine's tunnel is connected to this server right now. */
  online: z.boolean(),
})
export type ServerMachine = z.infer<typeof serverMachine>

export const listMachinesResponse = z.object({ machines: z.array(serverMachine) })
export type ListMachinesResponse = z.infer<typeof listMachinesResponse>

export const linkMachineBody = z.strictObject({ machineId: machineIdSchema, name: machineNameSchema })
export type LinkMachineBody = z.infer<typeof linkMachineBody>

export const renameMachineBody = z.strictObject({ machineId: machineIdSchema, name: machineNameSchema })
export type RenameMachineBody = z.infer<typeof renameMachineBody>

export const unlinkMachineBody = z.strictObject({ machineId: machineIdSchema })

export const unlinkMachineResponse = z.object({ ok: z.literal(true) })

export const serverMachinesContract = defineServerContract({
  list: {
    method: 'GET',
    path: '/api/machines',
    description: "Lists the signed-in user's machines, newest `lastOpenedAt` first, each marked online or offline.",
    input: z.strictObject({}),
    output: listMachinesResponse,
  },
  link: {
    method: 'POST',
    path: '/api/machines',
    description:
      'Links a machine to the account when a connect link is opened. Linking it again keeps its name and refreshes `lastOpenedAt`.',
    input: linkMachineBody,
    output: serverMachine,
  },
  rename: {
    method: 'PATCH',
    path: '/api/machines/:machineId',
    description: "Renames one of the signed-in user's machines.",
    input: renameMachineBody,
    output: serverMachine,
  },
  unlink: {
    method: 'DELETE',
    path: '/api/machines/:machineId',
    description: 'Removes a machine from the account. It does not touch the machine or its access key.',
    input: unlinkMachineBody,
    output: unlinkMachineResponse,
  },
})
