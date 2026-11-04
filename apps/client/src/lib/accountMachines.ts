import {
  type CreateEnrollmentResponse,
  machineNameSchema,
  type RelayTicketResponse,
  type ServerMachine,
  serverRoutes,
} from '@orch/shared'
import { formOptions } from '@tanstack/react-form'
import type { QueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { accountQuery } from './auth'
import { forgetMachine } from './machines'
import { callServer, ServerError, serverMutation } from './server'

// The machines linked to the signed-in account, from the accounts API. It only ever sends machine ids and names: the
// access keys stay in this browser (`./machines`), and the host checks them on every request.

/** How often the list is read again while it is on screen, so each machine's online state stays current. */
export const MACHINES_REFETCH_INTERVAL = 10_000

/** How often the list is read again while the Connect a machine dialog waits for the machine to link. */
export const MACHINES_LINKING_REFETCH_INTERVAL = 2_000

/**
 * The query for the account's machines, in the server's order, with each one's online state. With `linking` it is
 * read every 2 seconds instead of every 10, so a machine that redeems an enrollment key shows up quickly.
 */
export function machinesQuery(userId: string, { linking = false }: { linking?: boolean } = {}) {
  return {
    ...accountQuery(userId, serverRoutes.machines.list, {}),
    refetchInterval: linking ? MACHINES_LINKING_REFETCH_INTERVAL : MACHINES_REFETCH_INTERVAL,
  }
}

/**
 * Creates a single-use enrollment key. It goes around TanStack Query on purpose: the key is shown once, so the caller
 * holds it in component state and it is gone when the dialog closes, never kept in a query or mutation cache.
 */
export function createEnrollment(): Promise<CreateEnrollmentResponse> {
  return callServer(serverRoutes.machines.createEnrollment, {})
}

/**
 * The first machine in `machines` whose id isn't in `baseline`, the ids listed when an enrollment key was created.
 * Undefined means none is new. The client hears nothing when a key is redeemed, so a machine that appears is taken to
 * be the one that redeemed it.
 */
export function newMachine(baseline: readonly string[], machines: readonly ServerMachine[]): ServerMachine | undefined {
  const known = new Set(baseline)
  return machines.find((machine) => !known.has(machine.machineId))
}

function invalidateMachines(queryClient: QueryClient, userId: string) {
  return queryClient.invalidateQueries({ queryKey: machinesQuery(userId).queryKey })
}

/** Renames one of `userId`'s machines, then reads the list again. */
export function renameMachineMutation(queryClient: QueryClient, userId: string) {
  return {
    ...serverMutation(serverRoutes.machines.rename),
    onSuccess: () => invalidateMachines(queryClient, userId),
  }
}

/**
 * Unlinks one of `userId`'s machines, forgets its key in this browser, then reads the list again. The list shows only
 * the account's machines, so a key left behind could never be seen or removed.
 */
export function unlinkMachineMutation(queryClient: QueryClient, userId: string) {
  return {
    ...serverMutation(serverRoutes.machines.unlink),
    onSuccess: (_: unknown, { machineId }: { machineId: string }) => {
      forgetMachine(machineId)
      return invalidateMachines(queryClient, userId)
    },
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
