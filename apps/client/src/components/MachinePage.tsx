import { createRemoteTransport, TerminalUI, type TerminalUIProps } from '@orch/terminal-ui'
import { ArrowLeft } from '@orch/ui/icons'
import { Link, Outlet, useNavigate, useParams } from '@tanstack/react-router'
import { useCallback, useMemo } from 'react'
import { machinePath, type SavedMachine, useMachines } from '../lib/machines'
import { Centered, linkClass } from './Centered'

/** The cloud server: `VITE_SERVER_URL` from the build, or the origin the client is served from. */
function serverUrl(): string {
  return import.meta.env.VITE_SERVER_URL || location.origin
}

/** A machine's page, or a note that it isn't linked here. */
export function MachinePage({ machineId }: { machineId: string }) {
  const machine = useMachines().find((m) => m.id === machineId)
  if (!machine) {
    return (
      <Centered>
        <p>This machine isn't linked in this browser.</p>
        <Link to="/" className={`text-xs ${linkClass}`}>
          Back to your machines
        </Link>
      </Centered>
    )
  }
  return <MachineTerminalUI machine={machine} />
}

const offlineHint = 'The machine is offline, or not connected to the server. Check that its host is running.'

const deniedHint = (
  <>
    The machine's key has changed. Run{' '}
    <code className="rounded bg-raised px-1.5 py-0.5 font-mono text-ink">bun run host:rotate-key</code> on the machine
    and open the new connect link it prints.
  </>
)

function MachineTerminalUI({ machine }: { machine: SavedMachine }) {
  const { id, name, key } = machine
  const { workspaceId } = useParams({ strict: false })
  const routerNavigate = useNavigate()

  // One transport per machine and key, so moving between workspaces keeps the connection.
  const transport = useMemo(
    () => createRemoteTransport({ serverUrl: serverUrl(), machineId: id, accessKey: key }),
    [id, key],
  )
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
      <Link
        to="/"
        className="flex h-9 shrink-0 items-center gap-1.5 border-b border-line px-3 text-xs text-dim outline-none hover:text-ink focus-visible:bg-raised focus-visible:text-ink"
      >
        <ArrowLeft size={13} />
        All machines
      </Link>
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
