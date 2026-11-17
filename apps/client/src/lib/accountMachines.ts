import { type CreateEnrollmentResponse, machineNameSchema, type RelayTicketResponse, serverRoutes } from '@orch/shared'
import { formOptions } from '@tanstack/react-form'
import type { QueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { accountQuery } from './auth'
import { callServer, ServerError, serverMutation } from './server'

// The machines linked to the signed-in account, from the accounts API. It only ever sends machine ids and names; a
// machine page opens through the account with relay tickets (`relayTicketFor`), never with an access key.

/** How often the list is read again while it is on screen, so each machine's online state stays current. */
export const MACHINES_REFETCH_INTERVAL = 10_000

/** How often the waiting connect requests are read again on the home page. */
export const REQUESTS_REFETCH_INTERVAL = 10_000

/** How often the waiting connect requests are read again while the Connect a machine dialog waits for its own. */
export const REQUESTS_WAITING_REFETCH_INTERVAL = 2_000

/** The query for the account's machines, in the server's order, with each one's online state. */
export function machinesQuery(userId: string) {
  return { ...accountQuery(userId, serverRoutes.machines.list, {}), refetchInterval: MACHINES_REFETCH_INTERVAL }
}

/**
 * The query for the machines waiting for the owner to accept or reject their Connect, newest first. With `waiting`
 * it is read every 2 seconds instead of every 10, so the dialog that created a key shows its request quickly.
 */
export function requestsQuery(userId: string, { waiting = false }: { waiting?: boolean } = {}) {
  return {
    ...accountQuery(userId, serverRoutes.machines.listRequests, {}),
    refetchInterval: waiting ? REQUESTS_WAITING_REFETCH_INTERVAL : REQUESTS_REFETCH_INTERVAL,
  }
}

/**
 * Creates a single-use enrollment key. It goes around TanStack Query on purpose: the key is shown once, so the caller
 * holds it in component state and it is gone when the dialog closes, never kept in a query or mutation cache.
 */
export function createEnrollment(): Promise<CreateEnrollmentResponse> {
  return callServer(serverRoutes.machines.createEnrollment, {})
}

function invalidateMachines(queryClient: QueryClient, userId: string) {
  return queryClient.invalidateQueries({ queryKey: machinesQuery(userId).queryKey })
}

function invalidateRequests(queryClient: QueryClient, userId: string) {
  return queryClient.invalidateQueries({ queryKey: requestsQuery(userId).queryKey })
}

/**
 * Accepts one of `userId`'s waiting connect requests, which links its machine, then reads the machines again. The
 * requests are read again either way, so one that stopped waiting goes too.
 */
export function acceptRequestMutation(queryClient: QueryClient, userId: string) {
  return {
    ...serverMutation(serverRoutes.machines.acceptRequest),
    onSuccess: () => invalidateMachines(queryClient, userId),
    onSettled: () => invalidateRequests(queryClient, userId),
  }
}

/** Rejects one of `userId`'s waiting connect requests, then reads the requests again, whatever the answer. */
export function rejectRequestMutation(queryClient: QueryClient, userId: string) {
  return {
    ...serverMutation(serverRoutes.machines.rejectRequest),
    onSettled: () => invalidateRequests(queryClient, userId),
  }
}

/** What the page says when answering a connect request failed: `not_waiting` means the machine stopped waiting. */
export function requestAnswerFailed(error: unknown): string {
  return error instanceof ServerError && error.code === 'not_waiting'
    ? 'The machine stopped waiting. Nothing was linked.'
    : 'Answering the request failed. Try again.'
}

/** Renames one of `userId`'s machines, then reads the list again. */
export function renameMachineMutation(queryClient: QueryClient, userId: string) {
  return {
    ...serverMutation(serverRoutes.machines.rename),
    onSuccess: () => invalidateMachines(queryClient, userId),
  }
}

/** Unlinks one of `userId`'s machines, then reads the list again. */
export function unlinkMachineMutation(queryClient: QueryClient, userId: string) {
  return {
    ...serverMutation(serverRoutes.machines.unlink),
    onSuccess: () => invalidateMachines(queryClient, userId),
  }
}

/**
 * Gets a relay ticket that opens `machineId` as the signed-in account, for the machine page's transport. Null means
 * the account doesn't list the machine. It goes around TanStack Query on purpose: a ticket is a short-lived
 * credential, so it never sits in a query cache, storage, a URL or a log.
 */
export async function relayTicketFor(machineId: string): Promise<RelayTicketResponse | null> {
  try {
    return await callServer(serverRoutes.machines.relayTicket, { machineId })
  } catch (error) {
    if (error instanceof ServerError && error.code === 'not_found') return null
    throw error
  }
}

/** What the rename form checks: the contract's machine name, with readable messages first. */
export const renameMachineSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name.').max(64, 'Use at most 64 characters.').pipe(machineNameSchema),
})

/**
 * The inline rename form's options, starting from the machine's current `name`. A valid submit calls `rename` with
 * the trimmed name; an invalid one never does.
 */
export function renameMachineFormOptions(name: string, rename: (name: string) => Promise<unknown>) {
  return formOptions({
    defaultValues: { name },
    validators: { onChange: renameMachineSchema, onBlur: renameMachineSchema },
    onSubmit: async ({ value }) => {
      await rename(renameMachineSchema.parse(value).name)
    },
  })
}
