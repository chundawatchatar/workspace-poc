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

/**
 * An enrollment key: `oek_` and 32 random bytes as unpadded base64url. A
 * signed-in user creates one to link a machine from the machine itself.
 */
export const enrollmentKeySchema = z.string().regex(/^oek_[A-Za-z0-9_-]{43}$/, 'Not an enrollment key.')

/** The part of an enrollment key shown to compare it on both screens: its last 4 characters. */
export function enrollmentFingerprint(key: string): string {
  return key.slice(-4)
}

/** A new enrollment key. It is shown once, works once and expires at `expiresAt`, an ISO string. */
export const createEnrollmentResponse = z.object({
  key: enrollmentKeySchema,
  fingerprint: z.string().length(4),
  expiresAt: z.iso.datetime(),
})
export type CreateEnrollmentResponse = z.infer<typeof createEnrollmentResponse>

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
  createEnrollment: {
    method: 'POST',
    path: '/api/machines/enrollments',
    description:
      'Creates a single-use enrollment key, valid for 15 minutes, that a machine redeems over its tunnel to link itself.',
    input: z.strictObject({}),
    output: createEnrollmentResponse,
  },
})
