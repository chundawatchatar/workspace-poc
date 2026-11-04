import { createRemoteTransport, TerminalUI, type TerminalUIProps } from '@orch/terminal-ui'
import { Button, FormError } from '@orch/ui'
import { ArrowLeft } from '@orch/ui/icons'
import { useQuery } from '@tanstack/react-query'
import { Link, Outlet, useNavigate, useParams } from '@tanstack/react-router'
import { type ReactNode, useCallback, useMemo } from 'react'
import { machinesQuery } from '../../lib/accountMachines'
import { sessionQuery } from '../../lib/auth'
import { machinePath, useMachines } from '../../lib/machines'
import { AccountMenu } from '../account/AccountMenu'
import { Centered, linkClass } from '../Centered'

/** The cloud server: `VITE_SERVER_URL` from the build, or the origin the client is served from. */
function serverUrl(): string {
  return import.meta.env.VITE_SERVER_URL || location.origin
}

/** The machine a page opens: with `key` through its access key, without it through the signed-in account. */
interface OpenedMachine {
  id: string
  name: string
  key?: string
}

/**
 * A machine's page, or a note that it isn't linked here. A key saved in this browser wins, so a connect link opens
 * its machine as it always did; otherwise the account opens a machine it lists.
 */
export function MachinePage({ machineId }: { machineId: string }) {
  const saved = useMachines().find((m) => m.id === machineId)
  const session = useQuery(sessionQuery)
  if (saved) return <MachineTerminalUI machine={saved} />
  if (session.isPending) return <Loading />
  const userId = session.data?.id
  if (!userId) return <NotLinked />
  return <AccountMachinePage machineId={machineId} userId={userId} />
}

function Loading() {
  return (
    <Centered>
      <p role="status">Loading the machine…</p>
    </Centered>
  )
}

/** A machine opened through the account, named from the account's list. */
function AccountMachinePage({ machineId, userId }: { machineId: string; userId: string }) {
  const list = useQuery(machinesQuery(userId))
  // Once listed, a failed refetch keeps the page open rather than tearing down its terminals.
  if (list.data) {
    const listed = list.data.machines.find((m) => m.machineId === machineId)
    return listed ? <MachineTerminalUI machine={{ id: machineId, name: listed.name }} /> : <NotLinked />
  }
  if (list.isError) {
    return (
      <Centered>
        <FormError message="Loading your machines failed." />
        <Button variant="secondary" pending={list.isFetching} onClick={() => void list.refetch()}>
          Retry
        </Button>
      </Centered>
    )
  }
  return <Loading />
}

function NotLinked() {
  return (
    <Centered>
      <p>
        This machine isn't linked to your account or in this browser. Link it with Connect a machine on the home page,
        or open its connect link on this device.
      </p>
      <Link to="/" className={`text-xs ${linkClass}`}>
        Back to your machines
      </Link>
    </Centered>
  )
}

const offlineHint = 'The machine is offline, or not connected to the server. Check that its host is running.'

const keyDeniedHint = (
  <>
    The machine's key has changed. Run{' '}
    <code className="rounded bg-raised px-1.5 py-0.5 font-mono text-ink">bun run host:rotate-key</code> on the machine
    and open the new connect link it prints.
  </>
)

const accountDeniedHint = (
  <>
    The machine isn't linked to this account on its host. Link it again with an enrollment key: use Connect a machine on
    the home page, then{' '}
    <code className="rounded bg-raised px-1.5 py-0.5 font-mono text-ink">bun run host:remote link &lt;key&gt;</code> on
    the machine, or its Remote access setting.
  </>
)

function MachineTerminalUI({ machine }: { machine: OpenedMachine }) {
  const { id, name, key } = machine
  const { workspaceId } = useParams({ strict: false })
  const routerNavigate = useNavigate()

  // One transport per machine and key, so moving between workspaces keeps the connection. Without a key, the
  // account opens the machine.
  const transport = useMemo(
    () => createRemoteTransport({ serverUrl: serverUrl(), machineId: id, ...(key ? { accessKey: key } : {}) }),
    [id, key],
  )
  const deniedHint: ReactNode = key ? keyDeniedHint : accountDeniedHint
  const info = useMemo(() => ({ id, name }), [id, name])
  const navigate = useCallback<TerminalUIProps['navigate']>(
    ({ workspaceId }, options) =>
      void (workspaceId === undefined
        ? routerNavigate({ to: '/m/$machineId', params: { machineId: id }, replace: options?.replace })
        : routerNavigate({
            to: '/m/$machineId/w/$workspaceId',
            params: { machineId: id, workspaceId },
            replace: options?.replace,
          })),
    [routerNavigate, id],
  )
  const workspaceHref = useCallback(
    (workspaceId: string) => `${machinePath(id)}/w/${encodeURIComponent(workspaceId)}`,
    [id],
  )
  const header = useMemo(
    () => (
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line pr-2">
        <Link
          to="/"
          className="flex h-full shrink-0 items-center gap-1.5 px-3 text-xs text-dim outline-none hover:text-ink focus-visible:bg-raised focus-visible:text-ink"
        >
          <ArrowLeft size={13} />
          All machines
        </Link>
        <AccountMenu className="ml-auto min-w-0" />
      </div>
    ),
    [],
  )

  return (
    <TerminalUI
      transport={transport}
      workspaceId={workspaceId}
      navigate={navigate}
      workspaceHref={workspaceHref}
      machine={info}
      header={header}
      offlineHint={offlineHint}
      deniedHint={deniedHint}
      titleSuffix={name}
    >
      <Outlet />
    </TerminalUI>
  )
}
