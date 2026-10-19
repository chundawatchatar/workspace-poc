import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

export function getRouter() {
  // One client per router, so server renders never share a cache between requests.
  // The host is on loopback, so it stays reachable when the browser reports offline: don't pause requests then.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { networkMode: 'always' }, mutations: { networkMode: 'always' } },
  })
  return createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: false,
    defaultPreload: false,
    defaultNotFoundComponent: () => <div className="p-6 text-dim">Page not found.</div>,
    Wrap: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
