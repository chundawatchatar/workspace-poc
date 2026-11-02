import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { act, render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'

export interface RenderWithProvidersOptions {
  /** Where the router starts, such as `/settings/security`. Defaults to `/`. */
  path?: string
}

/**
 * Renders `ui` the way the app does: inside a fresh `QueryClient` (no retries, so a refused request fails at once)
 * and a memory-history router that shows `ui` at every path, so a component can link and navigate anywhere and the
 * test reads where it went from `router.state.location`. Resolves once the router has loaded `path`. Returns Testing
 * Library's result plus the `queryClient` (seed it with `setQueryData`), the `router` and a `userEvent` instance.
 */
export async function renderWithProviders(ui: ReactElement, { path = '/' }: RenderWithProvidersOptions = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const rootRoute = createRootRoute()
  const page = createRoute({ getParentRoute: () => rootRoute, path: '$', component: () => ui })
  const router = createRouter({
    routeTree: rootRoute.addChildren([page]),
    history: createMemoryHistory({ initialEntries: [path] }),
  })
  const user = userEvent.setup()
  const result = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  await act(() => router.load())
  return { ...result, queryClient, router, user }
}
