import { QueryClient } from '@tanstack/react-query'
import { createRouter, type RouterHistory } from '@tanstack/react-router'
import { watchIdentity } from './lib/auth'
import { acceptEmailLinkToken } from './lib/emailLink'
import { acceptConnectLink } from './lib/machines'
import { ServerError } from './lib/server'
import { routeTree } from './routeTree.gen'

/** What every route can read from the router's context. */
export interface RouterContext {
  /** The browser session's query client, shared by every route. */
  queryClient: QueryClient
}

/**
 * Creates the client's router. Start calls it once per browser session and once to prerender the shell. Tests pass
 * a memory history; the app uses the browser's.
 */
export function getRouter(history?: RouterHistory) {
  // Links carry secrets in the fragment: a connect link's key on any path, and an emailed link's token on its page.
  // Read them before the router does, so the router starts on the right page and neither reaches its history.
  if (!history && typeof window !== 'undefined') {
    acceptConnectLink()
    acceptEmailLinkToken()
    // An emailed link opened in a tab already on its page changes only the fragment. This listener is added before
    // the router's own, so the token leaves the URL before the router reads it.
    window.addEventListener('popstate', () => acceptEmailLinkToken())
  }
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        // Retrying a refused request only delays the answer, such as the `unauthorized` that finds a revoked session.
        retry: (failures, error) => failures < 3 && !(error instanceof ServerError && error.status < 500),
      },
    },
  })
  const router = createRouter({
    routeTree,
    history,
    context: { queryClient },
    scrollRestoration: false,
    defaultPreload: false,
  })
  // A different user means different data and different answers from the guards.
  watchIdentity(queryClient, () => void router.invalidate())
  return router
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
