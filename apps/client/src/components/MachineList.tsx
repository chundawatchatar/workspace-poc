import { Button, FormError } from '@orch/ui'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { machinesQuery } from '../lib/accountMachines'
import { sessionQuery, signOut } from '../lib/auth'
import { useMachines } from '../lib/machines'
import { focusClass } from './Centered'
import { MachineRow } from './MachineRow'

/** The home page: the machines linked to the signed-in account. */
export function MachineList() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const user = useQuery(sessionQuery).data
  const [signOutFailed, setSignOutFailed] = useState(false)
  const onSignOut = async () => {
    try {
      await signOut(queryClient)
      await navigate({ to: '/auth/sign-in' })
    } catch {
      setSignOutFailed(true)
    }
  }
  return (
    <div className="mx-auto flex h-full max-w-2xl flex-col gap-4 overflow-y-auto p-8">
      <div className="flex items-center gap-3">
        <h1 className="flex-1 text-base font-semibold text-ink">Your machines</h1>
        <button
          type="button"
          className={`px-1.5 py-0.5 text-xs text-dim hover:bg-raised hover:text-ink active:bg-line ${focusClass}`}
          onClick={() => void onSignOut()}
        >
          Sign out
        </button>
      </div>
      {signOutFailed && (
        <p role="alert" className="text-xs text-dim">
          Signing out failed. Try again.
        </p>
      )}
      {user ? <AccountMachines userId={user.id} /> : <Loading />}
    </div>
  )
}

function Loading() {
  return (
    <p role="status" className="text-dim">
      Loading your machines…
    </p>
  )
}

function AccountMachines({ userId }: { userId: string }) {
  const list = useQuery(machinesQuery(userId))
  const saved = useMachines()

  if (list.isPending) return <Loading />
  if (list.isError) {
    return (
      <div className="flex flex-col items-start gap-2">
        <FormError message="Loading your machines failed." />
        <Button variant="secondary" pending={list.isFetching} onClick={() => void list.refetch()}>
          Retry
        </Button>
      </div>
    )
  }
  const { machines } = list.data
  if (machines.length === 0) {
    return (
      <div className="flex flex-col gap-2 text-dim">
        <p>No machines are linked to your account yet.</p>
        <p className="text-xs">
          To connect one, run its host with remote access on, then open the connect link the machine printed while
          signed in on this device.
        </p>
      </div>
    )
  }
  return (
    <ul className="divide-y divide-line rounded-md border border-line">
      {machines.map((machine) => (
        <MachineRow
          key={machine.machineId}
          machine={machine}
          userId={userId}
          hasKey={saved.some((m) => m.id === machine.machineId)}
        />
      ))}
    </ul>
  )
}
