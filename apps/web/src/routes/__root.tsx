import { createRootRoute, HeadContent, Outlet, Scripts, useNavigate, useParams } from '@tanstack/react-router'
import { type ReactNode, useEffect } from 'react'
import { Overlays } from '../components/Overlays'
import { Sidebar } from '../components/Sidebar'
import { useShortcuts } from '../lib/shortcuts'
import { SIDEBAR_BOOT_SCRIPT } from '../lib/sidebarWidth'
import { connect, initTheme, useApp } from '../lib/store'
import { THEME_BOOT_SCRIPT } from '../lib/themes'
import appCss from '../styles.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Workspaces' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  shellComponent: RootDocument,
  component: RootLayout,
})

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: `${THEME_BOOT_SCRIPT};${SIDEBAR_BOOT_SCRIPT}` }} />
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}

function RootLayout() {
  const { workspaceId } = useParams({ strict: false }) as { workspaceId?: string }
  const workspace = useApp((s) => s.state?.workspaces.find((w) => w.id === workspaceId))
  const sidebar = useApp((s) => s.sidebar)
  const navigate = useNavigate()

  useEffect(connect, [])
  useEffect(initTheme, [])
  useShortcuts(workspace, (id) => void navigate({ to: '/w/$workspaceId', params: { workspaceId: id } }))

  return (
    <div className="flex h-screen w-screen">
      <Sidebar activeId={workspaceId} open={sidebar} />
      <main className="flex min-w-0 flex-1 flex-col">
        <Outlet />
      </main>
      <Overlays />
    </div>
  )
}
