import { HOST_PORT } from '@orch/shared'
import {
  createLocalTransport,
  NotFound,
  SIDEBAR_BOOT_SCRIPT,
  TerminalUI,
  type TerminalUIProps,
} from '@orch/terminal-ui'
import { THEME_BOOT_SCRIPT } from '@orch/ui'
import { createRootRoute, HeadContent, Outlet, Scripts, useNavigate, useParams } from '@tanstack/react-router'
import { type ReactNode, useCallback } from 'react'
import appCss from '../styles.css?url'

// The host listens on the loopback address only.
const transport = createLocalTransport(`http://127.0.0.1:${HOST_PORT}`)

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
  // Rendered in the root's outlet, so an unknown path keeps the sidebar.
  notFoundComponent: NotFound,
})

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: Our own constant script, run before paint so the saved theme and sidebar width apply without a flash. */}
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

/** Rendered once for every route, so moving between workspaces keeps the page and its connection. */
function RootLayout() {
  const { workspaceId } = useParams({ strict: false }) as { workspaceId?: string }
  const routerNavigate = useNavigate()

  const navigate = useCallback<TerminalUIProps['navigate']>(
    ({ workspaceId }, options) =>
      void (workspaceId === undefined
        ? routerNavigate({ to: '/', replace: options?.replace })
        : routerNavigate({ to: '/w/$workspaceId', params: { workspaceId }, replace: options?.replace })),
    [routerNavigate],
  )
  const workspaceHref = useCallback((id: string) => `/w/${encodeURIComponent(id)}`, [])

  return (
    <TerminalUI transport={transport} workspaceId={workspaceId} navigate={navigate} workspaceHref={workspaceHref}>
      <Outlet />
    </TerminalUI>
  )
}
