import { Button, FormError } from '@orch/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table'
import { useId, useState } from 'react'
import { isNotFresh, revokeSession, type SessionRow, sessionsQuery } from '../lib/accountSessions'
import { sessionQuery, signOut } from '../lib/auth'
import { focusClass } from './Centered'

const smallButtonClass = `px-1.5 py-0.5 text-xs text-dim hover:bg-raised hover:text-ink active:bg-line disabled:opacity-60 ${focusClass}`

/** A date and time from the server, in the browser's locale and time zone. */
function LocalTime({ value }: { value: string }) {
  return (
    <time dateTime={value}>
      {new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
    </time>
  )
}

// Stable across renders, as TanStack Table asks: a new array would rebuild the row model every time.
const features = tableFeatures({})
const column = createColumnHelper<typeof features, SessionRow>()
const columns = column.columns([
  column.accessor('device', { header: 'Device' }),
  column.accessor('ipAddress', { header: 'IP address', cell: ({ getValue }) => getValue() ?? 'Unknown' }),
  column.accessor('createdAt', { header: 'Created', cell: ({ getValue }) => <LocalTime value={getValue()} /> }),
  column.accessor('lastActiveAt', {
    header: 'Last active',
    cell: ({ getValue }) => <LocalTime value={getValue()} />,
  }),
  column.display({
    id: 'action',
    header: () => <span className="sr-only">Action</span>,
    cell: ({ row }) =>
      row.original.current ? (
        <span className="text-xs text-good">This device</span>
      ) : (
        <RevokeButton row={row.original} />
      ),
  }),
])

/** Ends one other session. A failure stays in its row, and the list is left as it was. */
function RevokeButton({ row }: { row: SessionRow }) {
  const queryClient = useQueryClient()
  const userId = useQuery(sessionQuery).data?.id
  const revoke = useMutation({
    mutationFn: (id: string) => (userId ? revokeSession(queryClient, userId, id) : Promise.resolve()),
  })
  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        aria-label={`Revoke ${row.device}`}
        className={smallButtonClass}
        disabled={revoke.isPending}
        onClick={() => revoke.mutate(row.id)}
      >
        Revoke
      </button>
      {revoke.isError && <FormError message="Revoking failed. Try again." />}
    </div>
  )
}

/** The account's sessions, one row each, with the current one marked and the others revokable. */
export function SessionsTable({ userId }: { userId: string }) {
  const list = useQuery(sessionsQuery(userId))

  if (list.isPending) {
    return (
      <p role="status" className="text-dim">
        Loading your devices…
      </p>
    )
  }
  if (list.isError) {
    if (isNotFresh(list.error)) return <NotFresh />
    return (
      <div className="flex flex-col items-start gap-2">
        <FormError message="Loading your devices failed." />
        <Button variant="secondary" pending={list.isFetching} onClick={() => void list.refetch()}>
          Retry
        </Button>
      </div>
    )
  }
  return <Table rows={list.data} />
}

function Table({ rows }: { rows: SessionRow[] }) {
  const table = useTable({ features, columns, data: rows, getRowId: (row) => row.id })
  const noteId = useId()
  return (
    <>
      <div className="overflow-x-auto rounded-md border border-line">
        <table className="w-full text-left text-[13px]">
          <thead className="text-xs text-faint">
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id} className="border-b border-line">
                {group.headers.map((header) => (
                  <th
                    key={header.id}
                    scope="col"
                    aria-describedby={header.column.id === 'lastActiveAt' ? noteId : undefined}
                    className="px-3 py-2 font-medium whitespace-nowrap"
                  >
                    {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody className="divide-y divide-line">
            {table.getRowModel().rows.map((row) => (
              <tr key={row.id}>
                {row.getAllCells().map((cell) => (
                  <td
                    key={cell.id}
                    className={`px-3 py-2 align-top ${cell.column.id === 'action' ? 'text-right' : 'text-ink'}`}
                  >
                    <table.FlexRender cell={cell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p id={noteId} className="text-xs text-faint">
        Last active is approximate: it updates when the session is renewed, at most once a day.
      </p>
    </>
  )
}

/** What the table area says when the session is too old to list devices. */
function NotFresh() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [failed, setFailed] = useState(false)
  const [pending, setPending] = useState(false)
  const signInAgain = async () => {
    setPending(true)
    setFailed(false)
    try {
      await signOut(queryClient)
      await navigate({ to: '/auth/sign-in', search: { redirect: '/account' } })
    } catch {
      setFailed(true)
      setPending(false)
    }
  }
  return (
    <div className="flex flex-col items-start gap-2 text-dim">
      <p>For your security, seeing your devices needs a recent sign-in. Sign in again to see them.</p>
      <Button variant="secondary" pending={pending} onClick={() => void signInAgain()}>
        Sign in again
      </Button>
      <FormError message={failed ? 'Signing out failed. Try again.' : null} />
    </div>
  )
}
