import { machineNameSchema, serverRoutes } from '@orch/shared'
import { formOptions } from '@tanstack/react-form'
import type { QueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { accountQuery, sessionQuery } from './auth'
import { forgetMachine } from './machines'
import { clearPendingMachineLink, readPendingMachineLink } from './pendingLink'
import { callServer, ServerError, serverMutation } from './server'

// The machines linked to the signed-in account, from the accounts API. It only ever sends machine ids and names: the
// access keys stay in this browser (`./machines`), and the host checks them on every request.

/** How often the list is read again while it is on screen, so each machine's online state stays current. */
export const MACHINES_REFETCH_INTERVAL = 10_000

/** The query for the account's machines, in the server's order, with each one's online state. */
export function machinesQuery(userId: string) {
  return { ...accountQuery(userId, serverRoutes.machines.list, {}), refetchInterval: MACHINES_REFETCH_INTERVAL }
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

async function sendOnce(queryClient: QueryClient) {
  const user = queryClient.getQueryData(sessionQuery.queryKey)
  const link = readPendingMachineLink()
  if (!user || !link) return
  try {
    await callServer(serverRoutes.machines.link, { machineId: link.machineId, name: link.name })
  } catch (error) {
    // A refusal won't change on a retry, such as an id that isn't a machine's. A network error or a server failure
    // might, so the link waits for the next session read.
    if (error instanceof ServerError && error.status >= 400 && error.status < 500) clearPendingMachineLink(link)
    return
  }
  clearPendingMachineLink(link)
  await invalidateMachines(queryClient, user.id)
}

let sending: Promise<void> = Promise.resolve()

/**
 * Links the waiting connect link's machine, if any, to the user signed in in `queryClient`, then clears the link and
 * reads the list again. Calls run one after another, so a second call while one is on its way finds the link already
 * gone instead of sending it twice. It never throws.
 */
export function sendPendingMachineLink(queryClient: QueryClient): Promise<void> {
  sending = sending.then(() => sendOnce(queryClient).catch(() => {}))
  return sending
}
