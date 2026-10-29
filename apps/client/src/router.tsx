import { QueryClient } from '@tanstack/react-query'
import { createRouter, type RouterHistory } from '@tanstack/react-router'
import { watchIdentity } from './lib/auth'
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
  // A connect link works on any path. Read it before the router does, so the router starts on the machine's page
  // and the key never reaches the router's history.
  if (!history && typeof window !== 'undefined') acceptConnectLink()
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
