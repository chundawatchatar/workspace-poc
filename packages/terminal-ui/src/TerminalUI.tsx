import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { type ReactNode, useEffect, useMemo } from 'react'
import { ConnectionBanner } from './components/ConnectionBanner'
import { DEFAULT_DENIED_HINT, LOCAL_OFFLINE_HINT } from './components/HostStatus'
import { Overlays } from './components/Overlays'
import { Sidebar } from './components/Sidebar'
import { Toaster } from './components/Toaster'
import { useShortcuts } from './lib/shortcuts'
import { connect, initTheme, useApp } from './lib/store'
import { type Navigation, NavigationProvider, useNavigation } from './navigation'
import { type PageOptions, PageOptionsProvider } from './pageOptions'
import type { HostTransport } from './transport'
import { TransportProvider } from './transportContext'

export interface TerminalUIProps {
  /** How the page reaches the host. Every request and socket goes through it. */
  transport: HostTransport
  /** The workspace in the app's URL; `undefined` is the home page. */
  workspaceId: string | undefined
  /** Moves the app's URL to a workspace, or home when `workspaceId` is left out. */
  navigate: (target: { workspaceId?: string }, options?: { replace?: boolean }) => void
  /** The real href of a workspace, so its sidebar row can be middle-clicked or opened in a new tab. */
  workspaceHref: (workspaceId: string) => string
  /** The main area, from the app's router outlet: `HomeView`, `WorkspaceView` or `NotFound`. */
  children: ReactNode
  /** The machine this page is for. Its name replaces the "Workspaces" label in the sidebar. */
  machine?: { id: string; name: string }
  /** Rendered at the top of the sidebar, such as a link back to the app's own pages. */
  header?: ReactNode
  /** Says how to start the host when it is offline. Defaults to running `bun run dev` in the project root. */
  offlineHint?: ReactNode
  /** Says what to do when the host rejects the access key. Defaults to asking the machine's owner for a new link. */
  deniedHint?: ReactNode
  /** Follows the workspace name in the document title. Defaults to `Workspaces`. */
  titleSuffix?: string
  /**
   * Offers the "Remote access…" command, where the host's tunnel to the server
   * is set up. Only a local page can use it: the host refuses it through the tunnel.
   */
  remoteAccessSetting?: boolean
}

/** The page inside a machine: sidebar, workspace layout, overlays and toasts, connected through `transport`. */
export function TerminalUI({
  transport,
  workspaceId,
  navigate,
  workspaceHref,
  children,
  machine,
  header,
  offlineHint = LOCAL_OFFLINE_HINT,
  deniedHint = DEFAULT_DENIED_HINT,
  titleSuffix = 'Workspaces',
  remoteAccessSetting = false,
}: TerminalUIProps) {
  // One cache per transport, so another host's answers are never shown. The host may be on loopback, which stays
  // reachable when the browser reports offline, so don't pause requests then.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `transport` is the key, so a new transport gets an empty cache.
  const queryClient = useMemo(
    () =>
      new QueryClient({ defaultOptions: { queries: { networkMode: 'always' }, mutations: { networkMode: 'always' } } }),
    [transport],
  )
  const navigation = useMemo<Navigation>(
    () => ({ workspaceId, navigate, workspaceHref }),
    [workspaceId, navigate, workspaceHref],
  )
  const options = useMemo<PageOptions>(
    () => ({ machine, header, offlineHint, deniedHint, titleSuffix, remoteAccessSetting }),
    [machine, header, offlineHint, deniedHint, titleSuffix, remoteAccessSetting],
  )

  useEffect(() => connect(transport), [transport])
  useEffect(initTheme, [])

  return (
    <QueryClientProvider client={queryClient}>
      <TransportProvider value={transport}>
        <NavigationProvider value={navigation}>
          <PageOptionsProvider value={options}>
            <Page>{children}</Page>
          </PageOptionsProvider>
        </NavigationProvider>
      </TransportProvider>
    </QueryClientProvider>
  )
}

function Page({ children }: { children: ReactNode }) {
  const { workspaceId, navigate } = useNavigation()
  const workspace = useApp((s) => s.state?.workspaces.find((w) => w.id === workspaceId))
  const sidebar = useApp((s) => s.sidebar)

  useShortcuts(workspace, (id) => navigate({ workspaceId: id }))

  return (
    <div className="flex h-screen w-screen">
      <Sidebar activeId={workspaceId} open={sidebar} />
      <main className="flex min-w-0 flex-1 flex-col">
        <ConnectionBanner />
        {children}
      </main>
      <Overlays />
      <Toaster />
    </div>
  )
}
