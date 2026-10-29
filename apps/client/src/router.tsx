import { QueryClient } from '@tanstack/react-query'
import { createRouter, type RouterHistory } from '@tanstack/react-router'
import { acceptConnectLink } from './lib/machines'
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
  return createRouter({
    routeTree,
    history,
    context: { queryClient: new QueryClient() },
    scrollRestoration: false,
    defaultPreload: false,
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
