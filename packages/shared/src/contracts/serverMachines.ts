import { z } from 'zod'
import { relayTicketResponse } from './relayTicket'
import { defineServerContract } from './server'

// The machines linked to an account. The accounts API only ever handles machine ids and names: no schema here has a
// key field, and every input is strict, so a body that carries a key is refused rather than silently dropped.

/** A machine's id: the unpadded base64url SHA-256 of its raw Ed25519 public key, 43 characters. */
export const machineIdSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'Not a machine id.')

/** A machine's name as the user sees it, trimmed, 1 to 64 characters. */
export const machineNameSchema = z.string().trim().min(1).max(64)

/** A machine linked to the signed-in account. Dates are ISO strings. */
export const serverMachine = z.object({
  machineId: z.string(),
  name: z.string(),
  createdAt: z.iso.datetime(),
  /** When the machine was last linked. */
  lastOpenedAt: z.iso.datetime(),
  /** True when the machine's tunnel is connected to this server right now. */
  online: z.boolean(),
  /** True when the machine is not online and its last tunnel ended with `remote.off`. */
  remoteOff: z.boolean(),
})
export type ServerMachine = z.infer<typeof serverMachine>

export const listMachinesResponse = z.object({ machines: z.array(serverMachine) })
export type ListMachinesResponse = z.infer<typeof listMachinesResponse>

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

/**
 * The email of the account a machine connects to, as the owner types it:
 * trimmed, at most 254 characters. Its message never quotes the input.
 */
export const accountEmailSchema = z.string().trim().max(254).pipe(z.email('Not an email address.'))

/** The id of an enrollment key, which is also the id of the connect request a machine makes with it. */
export const connectRequestIdSchema = z.uuid('Not a request id.')

/**
 * A new enrollment key. It is shown once, works once and expires at
 * `expiresAt`, an ISO string. `id` is also the id of the connect request a
 * machine makes with it, so the page that created the key can find that
 * request. `serverUrl` is the address machines open their tunnel to on this
 * server, which `corch connect --server` takes.
 */
export const createEnrollmentResponse = z.object({
  id: connectRequestIdSchema,
  key: enrollmentKeySchema,
  fingerprint: z.string().length(4),
  expiresAt: z.iso.datetime(),
  serverUrl: z.string(),
})
export type CreateEnrollmentResponse = z.infer<typeof createEnrollmentResponse>

export const relayTicketBody = z.strictObject({ machineId: machineIdSchema })

/**
 * A machine waiting for the owner to accept or reject its Connect, made with
 * one of the owner's enrollment keys. `machineId` is the id its tunnel proved,
 * which the client turns into the fingerprint the owner compares with the one
 * the machine shows. Dates are ISO strings; the request ends at `expiresAt`,
 * when its key does.
 */
export const connectRequest = z.object({
  id: connectRequestIdSchema,
  machineId: machineIdSchema,
  name: z.string(),
  requestedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
})
export type ConnectRequest = z.infer<typeof connectRequest>

export const listRequestsResponse = z.object({ requests: z.array(connectRequest) })
export type ListRequestsResponse = z.infer<typeof listRequestsResponse>

export const connectRequestBody = z.strictObject({ id: connectRequestIdSchema })

export const rejectRequestResponse = z.object({ ok: z.literal(true) })

export const serverMachinesContract = defineServerContract({
  list: {
    method: 'GET',
    path: '/api/machines',
    description:
      "Lists the signed-in user's machines, newest `lastOpenedAt` first, each marked online, offline or remote access off.",
    input: z.strictObject({}),
    output: listMachinesResponse,
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
    description: 'Removes a machine from the account. It does not touch the machine.',
    input: unlinkMachineBody,
    output: unlinkMachineResponse,
  },
  createEnrollment: {
    method: 'POST',
    path: '/api/machines/enrollments',
    description:
      'Creates a single-use enrollment key, valid for 15 minutes, that a machine sends over its tunnel to ask to be linked. Its `id` is the id of that request.',
    input: z.strictObject({}),
    output: createEnrollmentResponse,
  },
  listRequests: {
    method: 'GET',
    path: '/api/machines/requests',
    description:
      "Lists the machines waiting for the signed-in user to accept or reject their Connect, newest first. A request ends when its machine's tunnel closes or its key expires.",
    input: z.strictObject({}),
    output: listRequestsResponse,
  },
  acceptRequest: {
    method: 'POST',
    path: '/api/machines/requests/:id/accept',
    description:
      "Accepts one of the signed-in user's waiting requests: uses up its key, links the machine under the name it asked with, tells the machine, and answers it. A request that stopped waiting answers `not_waiting` and changes nothing.",
    errors: { not_waiting: 409 },
    input: connectRequestBody,
    output: serverMachine,
  },
  rejectRequest: {
    method: 'POST',
    path: '/api/machines/requests/:id/reject',
    description:
      "Rejects one of the signed-in user's waiting requests: uses up its key, links nothing and tells the machine. A request that stopped waiting answers `not_waiting` and changes nothing.",
    errors: { not_waiting: 409 },
    input: connectRequestBody,
    output: rejectRequestResponse,
  },
  relayTicket: {
    method: 'POST',
    path: '/api/machines/:machineId/relay-ticket',
    description:
      "Signs a relay ticket that opens one of the signed-in user's machines for 60 seconds. A machine the user doesn't list answers `not_found`.",
    input: relayTicketBody,
    output: relayTicketResponse,
  },
})
