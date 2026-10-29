import { Monitor } from '@orch/ui/icons'
import { useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { signOut } from '../lib/auth'
import { forgetMachine, useMachines } from '../lib/machines'
import { focusClass, linkClass } from './Centered'

/** The home page: the machines linked in this browser. */
export function MachineList() {
  const machines = useMachines()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
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
    <div className="mx-auto flex h-full max-w-xl flex-col gap-4 overflow-y-auto p-8">
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
      {machines.length === 0 ? (
        <p className="text-dim">No machines are linked in this browser yet.</p>
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line">
          {machines.map((machine) => (
            <li key={machine.id} className="flex items-center gap-3 px-3 py-2">
              <Monitor size={15} className="shrink-0 text-faint" />
              <span className="min-w-0 flex-1 truncate" title={machine.id}>
                {machine.name}
              </span>
              <Link
                to="/m/$machineId"
                params={{ machineId: machine.id }}
                aria-label={`Open ${machine.name}`}
                className={`text-xs ${linkClass}`}
              >
                Open
              </Link>
              <button
                type="button"
                aria-label={`Forget ${machine.name}`}
                className={`px-1.5 py-0.5 text-xs text-dim hover:bg-raised hover:text-ink active:bg-line ${focusClass}`}
                onClick={() => forgetMachine(machine.id)}
              >
                Forget
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-faint">
        To link a machine, open the connect link it printed when it joined. The link saves the machine and its key in
        this browser.
      </p>
    </div>
  )
}
