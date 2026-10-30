import type { ServerMachine } from '@orch/shared'
import { Button, FormError, TextField } from '@orch/ui'
import { Monitor } from '@orch/ui/icons'
import { useForm } from '@tanstack/react-form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { renameMachineFormOptions, renameMachineMutation, unlinkMachineMutation } from '../lib/accountMachines'
import { shownError, submitOnce } from '../lib/authForms'
import { focusClass, linkClass } from './Centered'

/** What a machine page says when this browser holds no key for the machine. */
export const NO_KEY_HINT = 'Open the connect link on this device'

const smallButtonClass = `px-1.5 py-0.5 text-xs text-dim hover:bg-raised hover:text-ink active:bg-line ${focusClass}`

/**
 * One of the account's machines: its name and online state, an Open link when this browser holds its key, and
 * rename and unlink.
 */
export function MachineRow({
  machine,
  userId,
  hasKey,
}: {
  machine: ServerMachine
  userId: string
  /** True when this browser holds the machine's access key, so it can be opened here. */
  hasKey: boolean
}) {
  const queryClient = useQueryClient()
  const [renaming, setRenaming] = useState(false)
  const unlink = useMutation(unlinkMachineMutation(queryClient, userId))
  const { machineId, name, online } = machine

  return (
    <li className="flex flex-col gap-2 px-3 py-2">
      {renaming ? (
        <RenameForm machine={machine} userId={userId} onDone={() => setRenaming(false)} />
      ) : (
        <div className="flex items-center gap-3">
          <Monitor size={15} className="shrink-0 text-faint" />
          <span className="min-w-0 flex-1 truncate" title={machineId}>
            {name}
          </span>
          <span className={`flex items-center gap-1.5 text-xs ${online ? 'text-good' : 'text-faint'}`}>
            <span aria-hidden className={`size-1.5 rounded-full ${online ? 'bg-good' : 'bg-faint'}`} />
            {online ? 'Online' : 'Offline'}
          </span>
          {hasKey ? (
            <Link
              to="/m/$machineId"
              params={{ machineId }}
              aria-label={`Open ${name}`}
              className={`text-xs ${linkClass}`}
            >
              Open
            </Link>
          ) : (
            <span className="text-xs text-faint">{NO_KEY_HINT}</span>
          )}
          <button
            type="button"
            aria-label={`Rename ${name}`}
            className={smallButtonClass}
            onClick={() => setRenaming(true)}
          >
            Rename
          </button>
          <button
            type="button"
            aria-label={`Unlink ${name}`}
            className={smallButtonClass}
            disabled={unlink.isPending}
            onClick={() => unlink.mutate({ machineId })}
          >
            Unlink
          </button>
        </div>
      )}
      {unlink.isError && <FormError message="Unlinking the machine failed. Try again." />}
    </li>
  )
}

function RenameForm({ machine, userId, onDone }: { machine: ServerMachine; userId: string; onDone: () => void }) {
  const queryClient = useQueryClient()
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => input.current?.select(), [])
  const rename = useMutation(renameMachineMutation(queryClient, userId))
  const form = useForm(
    renameMachineFormOptions(machine.name, async (name) => {
      // A failure stays in the row with the typed name, so it can be sent again.
      await rename.mutateAsync({ machineId: machine.machineId, name }).then(onDone, () => {})
    }),
  )

  return (
    <form
      noValidate
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        submitOnce(form)
      }}
    >
      <form.Subscribe selector={(state) => state.submissionAttempts}>
        {(attempts) => (
          <form.Field name="name">
            {(field) => (
              <TextField
                ref={input}
                label={`New name for ${machine.name}`}
                name={field.name}
                autoComplete="off"
                required
                value={field.state.value}
                onChange={field.handleChange}
                onBlur={field.handleBlur}
                error={shownError(field.state.meta, attempts)}
              />
            )}
          </form.Field>
        )}
      </form.Subscribe>
      <FormError message={rename.isError ? 'Renaming the machine failed. Try again.' : null} />
      <div className="flex gap-2">
        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(submitting) => (
            <Button type="submit" pending={submitting}>
              Save
            </Button>
          )}
        </form.Subscribe>
        <Button variant="secondary" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
