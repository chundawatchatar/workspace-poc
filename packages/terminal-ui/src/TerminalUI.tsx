import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { Overlays } from './components/Overlays'
import { HomePage, WorkspacePage } from './components/Pages'
import { Sidebar } from './components/Sidebar'
import { Toaster } from './components/Toaster'
import { useShortcuts } from './lib/shortcuts'
import { connect, initTheme, useApp } from './lib/store'
import { type Navigation, NavigationProvider, useNavigation } from './navigation'
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
}

/** The page inside a machine: sidebar, workspace layout, overlays and toasts, connected through `transport`. */
export function TerminalUI({ transport, workspaceId, navigate, workspaceHref }: TerminalUIProps) {
  // One cache per mounted page. The host may be on loopback, which stays reachable when the browser reports
  // offline, so don't pause requests then.
  const [queryClient] = useState(
    () =>
      new QueryClient({ defaultOptions: { queries: { networkMode: 'always' }, mutations: { networkMode: 'always' } } }),
  )
  const navigation = useMemo<Navigation>(
    () => ({ workspaceId, navigate, workspaceHref }),
    [workspaceId, navigate, workspaceHref],
  )

  useEffect(() => connect(transport), [transport])
  useEffect(initTheme, [])

  return (
    <QueryClientProvider client={queryClient}>
      <TransportProvider value={transport}>
        <NavigationProvider value={navigation}>
          <Page />
        </NavigationProvider>
      </TransportProvider>
    </QueryClientProvider>
  )
}

function Page() {
  const { workspaceId, navigate } = useNavigation()
  const workspace = useApp((s) => s.state?.workspaces.find((w) => w.id === workspaceId))
  const sidebar = useApp((s) => s.sidebar)

  useShortcuts(workspace, (id) => navigate({ workspaceId: id }))

  return (
    <div className="flex h-screen w-screen">
      <Sidebar activeId={workspaceId} open={sidebar} />
      <main className="flex min-w-0 flex-1 flex-col">
        {workspaceId === undefined ? <HomePage /> : <WorkspacePage workspaceId={workspaceId} />}
      </main>
      <Overlays />
      <Toaster />
    </div>
  )
}
