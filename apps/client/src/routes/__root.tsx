import { SIDEBAR_BOOT_SCRIPT } from '@orch/terminal-ui'
import { FAVICON_HREF, PRODUCT_NAME, THEME_BOOT_SCRIPT } from '@orch/ui'
import { QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRootRouteWithContext, HeadContent, Outlet, Scripts, useNavigate } from '@tanstack/react-router'
import { type ReactNode, useEffect } from 'react'
import { PageNotFound } from '../components/PageNotFound'
import { sendPendingMachineLink } from '../lib/accountMachines'
import { sessionQuery } from '../lib/auth'
import { acceptConnectLink } from '../lib/machines'
import type { RouterContext } from '../router'
import appCss from '../styles.css?url'

export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: PRODUCT_NAME },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', type: 'image/svg+xml', href: FAVICON_HREF },
    ],
  }),
  shellComponent: RootDocument,
  component: RootLayout,
  // Unknown paths go to the catch-all routes (`$.tsx`, `m.$machineId.$.tsx`); this covers a route throwing `notFound()`.
  notFoundComponent: PageNotFound,
})

// The shell is prerendered into `index.html` at build time. The server allows inline scripts by their hashes in
// that file, so every inline script here must have fixed contents.
function RootDocument({ children }: { children: ReactNode }) {
  const { queryClient } = Route.useRouteContext()
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: Our own constant script, run before paint so the saved theme and sidebar width apply without a flash. */}
        <script dangerouslySetInnerHTML={{ __html: `${THEME_BOOT_SCRIPT};${SIDEBAR_BOOT_SCRIPT}` }} />
        <HeadContent />
      </head>
      <body>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        <Scripts />
      </body>
    </html>
  )
}

function RootLayout() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  // Keeps the session observed on every page, so it refetches on focus and a sign-out elsewhere is noticed.
  const userId = useQuery(sessionQuery).data?.id
  // Whenever a user is signed in, the connect link that was waiting for it is linked to their account. The identity
  // watcher has already cleared a link left by another user by the time this runs.
  useEffect(() => {
    if (userId) void sendPendingMachineLink(queryClient)
  }, [userId, queryClient])
  // A connect link opened on a page that is already open only changes the hash.
  useEffect(() => {
    const onHashChange = () => {
      const machineId = acceptConnectLink()
      if (!machineId) return
      void sendPendingMachineLink(queryClient)
      void navigate({ to: '/m/$machineId', params: { machineId }, replace: true })
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [navigate, queryClient])
  return <Outlet />
}
