import { FAVICON_HREF } from '@orch/brand'
import {
  createLocalTransport,
  type HostTransport,
  NotFound,
  SIDEBAR_BOOT_SCRIPT,
  TerminalUI,
  type TerminalUIProps,
} from '@orch/terminal-ui'
import { THEME_BOOT_SCRIPT, Toaster } from '@orch/ui'
import { createRootRoute, HeadContent, Outlet, Scripts, useNavigate, useParams } from '@tanstack/react-router'
import { type ReactNode, useCallback } from 'react'
import appCss from '../styles.css?url'

// The host listens on the loopback address only. In dev the page comes from Vite on `WEB_PORT` and is told where the
// host is; a build is served by the host itself, so it talks to the page's own origin, whatever port that is. The
// `DEV` check keeps a `VITE_HOST_URL` from the shell out of a build.
const transport =
  import.meta.env.DEV && import.meta.env.VITE_HOST_URL
    ? createLocalTransport(import.meta.env.VITE_HOST_URL)
    : sameOriginTransport()

/** A transport to the origin that served the page, read at each call since the prerendered shell has no `window`. */
function sameOriginTransport(): HostTransport {
  return {
    request: (path, init) => fetch(`${window.location.origin}${path}`, init),
    openSocket: (path) => {
      const { protocol, host } = window.location
      return new WebSocket(`${protocol === 'https:' ? 'wss:' : 'ws:'}//${host}${path}`)
    },
  }
}

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Workspaces' },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', type: 'image/svg+xml', href: FAVICON_HREF },
    ],
  }),
  shellComponent: RootDocument,
  component: RootLayout,
  // Rendered in the root's outlet, so an unknown path keeps the sidebar.
  notFoundComponent: NotFound,
})

// The shell is prerendered into `index.html` at build time. The host allows inline scripts by their hashes in that
// file, so every inline script here must have fixed contents.
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
    <>
      <TerminalUI
        transport={transport}
        workspaceId={workspaceId}
        navigate={navigate}
        workspaceHref={workspaceHref}
        remoteAccessSetting
        remoteAccessStatus
      >
        <Outlet />
      </TerminalUI>
      <Toaster />
    </>
  )
}
