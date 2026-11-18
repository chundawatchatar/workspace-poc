import { afterEach, beforeEach, mock } from 'bun:test'
import { machineSealedSocketPath, routes, serverRoutes } from '@orch/shared'
import { QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { act, render } from '@testing-library/react'
import { HttpResponse, http, ws } from 'msw'
import type { ReactNode } from 'react'
import { deviceKeyStores, indexedDbKeyStore } from '../lib/deviceKey'
import { indexedDbMachineKeyStore, machineKeyStores } from '../lib/machineKeys'
import { authSession, authUser } from './betterAuth'
import { memoryKeyStore } from './deviceKeyStore'
import { testMachine } from './machineKey'
import { memoryMachineKeyStore } from './machineKeyStore'
import { server } from './msw'

// The app's real router over the generated route tree, with the network faked, for tests that load whole pages.

// Vite turns `?url` imports into the asset's URL; Bun would hand the root route the stylesheet's module instead.
mock.module('../styles.css?url', () => ({ default: '/styles.css' }))
/** The app's `getRouter`, imported once the stylesheet is mocked. */
export const { getRouter } = await import('../router')
/** The signed-in user the fake server answers for. */
export const user = { id: 'u1', email: 'u1@example.com', name: 'U' }
/** The machine the account lists, whose key this browser already confirmed. */
export const account = testMachine()
const at = '2026-10-30T12:00:00.000Z'
/** The account's one machine, as the machine list answers it. */
export const listed = {
  machineId: account.id,
  name: 'Laptop',
  createdAt: at,
  lastOpenedAt: at,
  online: true,
  remoteOff: false,
}

/** Whether the fake server holds a session for the page's cookie. Each test starts signed in. */
export const fakeSession = { signedIn: true }

/**
 * Adds the fakes every app router test needs to the calling test file: the session, the machine list and the listed
 * machine answer by default, and the key stores are in memory. Call it once at the top level of the file.
 */
export function installAppFakes() {
  afterEach(() => {
    mock.restore()
    deviceKeyStores.default = indexedDbKeyStore
    machineKeyStores.default = indexedDbMachineKeyStore
    window.history.replaceState(null, '', '/')
  })
  beforeEach(installDefaults)
}

function installDefaults() {
  fakeSession.signedIn = true
  deviceKeyStores.default = memoryKeyStore().store
  const pinnedAt = '2026-11-01T12:00:00.000Z'
  machineKeyStores.default = memoryMachineKeyStore({
    [account.id]: { publicKey: account.publicKey, pinnedAt, source: 'confirmed' },
  }).store
  server.use(
    http.get('*/api/auth/get-session', () =>
      HttpResponse.json(fakeSession.signedIn ? { user: authUser(user), session: authSession('s1', user.id) } : null),
    ),
    http.post('*/api/auth/sign-in/email', () => {
      fakeSession.signedIn = true
      return HttpResponse.json({ redirect: false, token: 't1', user: authUser(user) })
    }),
    http.post('*/api/auth/sign-out', () => {
      fakeSession.signedIn = false
      return HttpResponse.json({ success: true })
    }),
    http.get('*/api/machines', () => HttpResponse.json({ machines: [listed] })),
    http.post('*/api/machines/:machineId/relay-ticket', () =>
      HttpResponse.json({ ticket: 'fake.relay.ticket', expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    ),
    http.get(`*${serverRoutes.machines.listRequests.path}`, () => HttpResponse.json({ requests: [] })),
    // The machine answers its own key, which the page checks before it opens any socket.
    http.get(`*/m/:machineId${routes.system.machineKey.path}`, ({ params }) =>
      params.machineId === account.id
        ? HttpResponse.json({ publicKey: account.publicKey })
        : new HttpResponse(null, { status: 404 }),
    ),
    // And opens an end-to-end session, signed with that key, before the page's first request or socket.
    http.post(`*/m/:machineId${routes.e2e.open.path}`, async ({ params, request }) =>
      params.machineId === account.id
        ? HttpResponse.json(await account.answer(await request.json()))
        : new HttpResponse(null, { status: 404 }),
    ),
  )
}

/**
 * The app's router over the generated route tree, starting at `path`. Its shell, the prerendered `<html>` document
 * with an inline boot script that the browser gets from `index.html`, can't be created on the client (React warns
 * about the script), so the test renders into happy-dom's body with a shell that does its one other job: providing
 * the router's query client.
 */
export function appRouter(path: string) {
  return withTestShell(getRouter(createMemoryHistory({ initialEntries: [path] })))
}

/** Gives `router` the test's shell, which provides its query client. */
export function withTestShell(router: ReturnType<typeof getRouter>) {
  const { queryClient } = router.options.context
  // `shellComponent` is TanStack Start's addition to the root route, so the router's own types don't list it.
  Object.assign(router.routesById.__root__.options, {
    shellComponent: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  })
  return router
}

/**
 * Accepts the machine page's event socket and never answers, so the page stays connecting. Resolves once the socket
 * connects, which waits for the device key and proof, so a test can end without leaving one to open after it.
 */
export function quietMachine(machineId: string): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  server.use(ws.link(`*${machineSealedSocketPath(machineId)}`).addEventListener('connection', () => resolve()))
  return promise
}

/** Loads `path` in the app's router, renders it, and returns the router. */
export async function show(path: string, router = appRouter(path)) {
  render(<RouterProvider router={router} />)
  await act(() => router.load())
  return router
}

/** Where the router landed after loading `path` and following any redirects. */
export async function land(path: string) {
  const router = appRouter(path)
  await router.load()
  return router.state.location
}
