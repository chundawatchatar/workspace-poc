import {
  createRemoteTransport,
  HomeView,
  NotFound,
  TerminalUI,
  type TerminalUIProps,
  WorkspaceView,
} from '@orch/terminal-ui'
import { ArrowLeft, Monitor } from '@orch/ui/icons'
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  type RouterHistory,
  useNavigate,
  useParams,
} from '@tanstack/react-router'
import { useCallback, useMemo } from 'react'
import { forgetMachine, machinePath, type SavedMachine, useMachines } from './lib/machines'

/** The cloud server: `VITE_SERVER_URL` from the build, or the origin the client is served from. */
function serverUrl(): string {
  return import.meta.env.VITE_SERVER_URL || location.origin
}

const linkClass = 'text-accent hover:underline'

const rootRoute = createRootRoute({
  component: Outlet,
  notFoundComponent: () => (
    <Centered>
      <p>Page not found.</p>
      <Link to="/" className={`text-xs ${linkClass}`}>
        Back to your machines
      </Link>
    </Centered>
  ),
})

const machinesRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: MachineList })

const machineRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/m/$machineId',
  component: MachinePage,
  notFoundComponent: NotFound,
})

const machineHomeRoute = createRoute({ getParentRoute: () => machineRoute, path: '/', component: HomeView })

const workspaceRoute = createRoute({
  getParentRoute: () => machineRoute,
  path: '/w/$workspaceId',
  component: function Workspace() {
    const { workspaceId } = workspaceRoute.useParams()
    return <WorkspaceView workspaceId={workspaceId} />
  },
})

export const routeTree = rootRoute.addChildren([
  machinesRoute,
  machineRoute.addChildren([machineHomeRoute, workspaceRoute]),
])

/** The client's router. Tests pass a memory history; the app uses the browser's. */
export function createAppRouter(history?: RouterHistory) {
  return createRouter({ routeTree, history, scrollRestoration: false, defaultPreload: false })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>
  }
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-dim">{children}</div>
}

/** The home page: the machines linked in this browser. */
function MachineList() {
  const machines = useMachines()
  return (
    <div className="mx-auto flex h-full max-w-xl flex-col gap-4 overflow-y-auto p-8">
      <h1 className="text-base font-semibold text-ink">Your machines</h1>
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
              <Link to="/m/$machineId" params={{ machineId: machine.id }} className={`text-xs ${linkClass}`}>
                Open
              </Link>
              <button
                type="button"
                className="rounded px-1.5 py-0.5 text-xs text-dim hover:bg-raised hover:text-ink"
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

/** A machine's page, or a note that it isn't linked here. */
function MachinePage() {
  const { machineId } = machineRoute.useParams()
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
        className="flex h-9 shrink-0 items-center gap-1.5 border-b border-line px-3 text-xs text-dim hover:text-ink"
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
      titleSuffix={name}
    >
      <Outlet />
    </TerminalUI>
  )
}
