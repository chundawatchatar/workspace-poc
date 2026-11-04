import { Button, FormError } from '@orch/ui'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { machinesQuery } from '../../lib/accountMachines'
import { sessionQuery } from '../../lib/auth'
import { AccountMenu } from '../account/AccountMenu'
import { ConnectMachineDialog } from './ConnectMachineDialog'
import { MachineRow } from './MachineRow'

/** The home page: the machines linked to the signed-in account. */
export function MachineList() {
  const user = useQuery(sessionQuery).data
  const [connecting, setConnecting] = useState(false)
  return (
    <div className="mx-auto flex h-full max-w-2xl flex-col gap-4 overflow-y-auto p-8">
      <div className="flex items-center gap-3">
        <h1 className="flex-1 text-base font-semibold text-ink">Your machines</h1>
        {user && <Button onClick={() => setConnecting(true)}>Connect a machine</Button>}
        <AccountMenu className="min-w-0" />
      </div>
      {user ? <AccountMachines userId={user.id} /> : <Loading />}
      {user && connecting && <ConnectMachineDialog userId={user.id} onClose={() => setConnecting(false)} />}
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
        <p className="text-xs">Use Connect a machine above to link one.</p>
      </div>
    )
  }
  return (
    <ul className="divide-y divide-line rounded-md border border-line">
      {machines.map((machine) => (
        <MachineRow key={machine.machineId} machine={machine} userId={userId} />
      ))}
    </ul>
  )
}
