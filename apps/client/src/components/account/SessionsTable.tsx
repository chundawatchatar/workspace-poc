import { formatLocalDateTime } from '@orch/shared'
import { Button, DataTable, type DataTableColumn, FormError } from '@orch/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { isNotFresh, revokeSession, type SessionRow, sessionsQuery } from '../../lib/accountSessions'
import { sessionQuery, signOut } from '../../lib/auth'
import { focusClass } from '../Centered'

const smallButtonClass = `px-1.5 py-0.5 text-xs text-dim hover:bg-raised hover:text-ink active:bg-line disabled:opacity-60 ${focusClass}`

// Outside the component, so the table isn't rebuilt on every render.
const columns: DataTableColumn<SessionRow>[] = [
  { id: 'device', header: 'Device', cell: (row) => row.device },
  { id: 'ipAddress', header: 'IP address', cell: (row) => row.ipAddress ?? 'Unknown' },
  {
    id: 'createdAt',
    header: 'Created',
    cell: (row) => <time dateTime={row.createdAt}>{formatLocalDateTime(row.createdAt)}</time>,
  },
  {
    id: 'lastActiveAt',
    header: 'Last active',
    note: 'Last active is approximate: it updates when the session is renewed, at most once a day.',
    cell: (row) => <time dateTime={row.lastActiveAt}>{formatLocalDateTime(row.lastActiveAt)}</time>,
  },
  {
    id: 'action',
    header: 'Action',
    hideHeader: true,
    align: 'end',
    cell: (row) => (row.current ? <span className="text-xs text-good">This device</span> : <RevokeButton row={row} />),
  },
]

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
  return <DataTable rows={list.data} columns={columns} getRowId={(row) => row.id} />
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
      await navigate({ to: '/auth/sign-in', search: { redirect: '/settings/security' } })
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
