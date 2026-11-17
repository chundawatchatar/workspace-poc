import {
  createRemoteTransport,
  type DeviceSigner,
  type HostTransport,
  TerminalUI,
  type TerminalUIProps,
} from '@orch/terminal-ui'
import { Button } from '@orch/ui'
import { ArrowLeft } from '@orch/ui/icons'
import { useQuery } from '@tanstack/react-query'
import { Link, Outlet, useNavigate, useParams } from '@tanstack/react-router'
import { type ReactNode, useCallback, useMemo } from 'react'
import { machinesQuery, relayTicketFor } from '../../lib/accountMachines'
import { sessionQuery } from '../../lib/auth'
import { loadDeviceKey } from '../../lib/deviceKey'
import { machinePath } from '../../lib/machines'
import { AccountMenu } from '../account/AccountMenu'
import { Centered, linkClass } from '../Centered'
import { MachineKeyCheck } from './MachineKeyCheck'
import { VerifiedMachine, type VerifiedTransportOptions } from './VerifiedMachine'

/** The cloud server: `VITE_SERVER_URL` from the build, or the origin the client is served from. */
function serverUrl(): string {
  return import.meta.env.VITE_SERVER_URL || location.origin
}

/** This browser's device key, and the fingerprint the user approves on a machine. */
interface DeviceKey {
  signer: DeviceSigner
  fingerprint: string
}

/**
 * The machine a page opens through the signed-in account's tickets, with this browser's `device` key, whose
 * `fingerprint` the user approves on the machine.
 */
interface OpenedMachine {
  id: string
  name: string
  device: DeviceKey
}

/**
 * This browser's device key, loaded once. It isn't account data: the same key opens every machine and account in this
 * browser profile, and only its public half and signatures ever leave it.
 */
const deviceKeyQuery = {
  queryKey: ['device-key'],
  queryFn: () => loadDeviceKey(),
  staleTime: Number.POSITIVE_INFINITY,
  gcTime: Number.POSITIVE_INFINITY,
  retry: false,
} as const

/** A machine's page, opened through the account when it lists the machine, or a note that it isn't linked. */
export function MachinePage({ machineId }: { machineId: string }) {
  const session = useQuery(sessionQuery)
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

/** Says this browser could not keep its device key, with a Retry. */
function DeviceKeyFailed({ retry, pending }: { retry: () => void; pending: boolean }) {
  return (
    <Centered>
      <p role="alert">This browser could not keep a device key, which opening a machine needs.</p>
      <Button variant="secondary" pending={pending} onClick={retry}>
        Retry
      </Button>
    </Centered>
  )
}

/** A machine opened through the account, named from the account's list, once this browser's device key is loaded. */
function AccountMachinePage({ machineId, userId }: { machineId: string; userId: string }) {
  const list = useQuery(machinesQuery(userId))
  const device = useQuery(deviceKeyQuery)
  if (device.isError) return <DeviceKeyFailed pending={device.isFetching} retry={() => void device.refetch()} />
  // Once listed, a failed refetch keeps the page open rather than tearing down its terminals.
  if (list.data && device.data) {
    const listed = list.data.machines.find((m) => m.machineId === machineId)
    return listed ? <OpenMachine machine={{ id: machineId, name: listed.name, device: device.data }} /> : <NotLinked />
  }
  if (list.isError) {
    return (
      <Centered>
        <p role="alert">Loading the machine failed.</p>
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
      <p>This machine isn't linked to your account.</p>
      <Link to="/" className={`text-xs ${linkClass}`}>
        Back to your machines
      </Link>
    </Centered>
  )
}

const offlineHint = 'The machine is offline, or not connected to the server. Check that its host is running.'

/** What to do after the machine refused this account, shown on every machine page. */
const deniedHint = (
  <>
    The machine isn't connected to this account on its host. Connect it again: use Connect a machine on the home page,
    then run the <code className="rounded bg-raised px-1.5 py-0.5 font-mono text-ink">corch connect</code> command it
    shows on the machine, or use its Remote access setting.
  </>
)

/** What to do while the machine waits for its owner to approve this browser. */
function unapprovedHint(fingerprint: string): ReactNode {
  return (
    <>
      Approve this browser on the machine: open Remote access there and approve{' '}
      <code className="rounded bg-raised px-1.5 py-0.5 font-mono text-ink">{fingerprint}</code>. Approve only this
      fingerprint.
    </>
  )
}

/**
 * A machine's transport, its key checked against this browser's pin before `<TerminalUI>` mounts, so a machine whose
 * key doesn't match never gets a terminal socket. `<TerminalUI>` then gets a transport bound to that pinned key. The
 * account's list doesn't vouch for the machine's key, so the owner confirms its fingerprint the first time.
 */
function OpenMachine({ machine }: { machine: OpenedMachine }) {
  const { id, device } = machine
  const { signer, fingerprint } = device

  // One transport per machine, so moving between workspaces keeps the connection. The account opens the machine
  // with relay tickets, and every request carries this browser's device proof. This one only fetches the key to
  // check: it can't open an end-to-end session before the key is known.
  const createTransport = useCallback(
    (e2e?: VerifiedTransportOptions) =>
      createRemoteTransport({
        serverUrl: serverUrl(),
        machineId: id,
        device: signer,
        relayTicket: () => relayTicketFor(id),
        ...e2e,
      }),
    [id, signer],
  )
  const transport = useMemo(() => createTransport(), [createTransport])
  const unapproved = useMemo(() => unapprovedHint(fingerprint), [fingerprint])
  return (
    <MachineKeyCheck machineId={id} transport={transport} unapprovedHint={unapproved} deniedHint={deniedHint}>
      {(publicKey) => (
        <VerifiedMachine publicKey={publicKey} createTransport={createTransport}>
          {(verified) => <MachineTerminalUI machine={machine} transport={verified} unapproved={unapproved} />}
        </VerifiedMachine>
      )}
    </MachineKeyCheck>
  )
}

function MachineTerminalUI({
  machine,
  transport,
  unapproved,
}: {
  machine: OpenedMachine
  transport: HostTransport
  unapproved: ReactNode
}) {
  const { id, name } = machine
  const { workspaceId } = useParams({ strict: false })
  const routerNavigate = useNavigate()
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
      unapprovedHint={unapproved}
      titleSuffix={name}
    >
      <Outlet />
    </TerminalUI>
  )
}
