import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { PRODUCT_NAME, PRODUCT_TAGLINE } from '@orch/brand'
import { routes } from '@orch/shared'
import { QueryClientProvider, useQueryClient } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { HttpResponse, http, ws } from 'msw'
import type { ReactNode } from 'react'
import { CheckInbox } from './components/auth/CheckInbox'
import { signInWithEmail, signOut } from './lib/auth'
import { deviceKeyStores, indexedDbKeyStore, loadDeviceKey } from './lib/deviceKey'
import { acceptEmailLinkToken, type EmailLinkPage, takeEmailLinkToken } from './lib/emailLink'
import { indexedDbMachineKeyStore, machineKeyStores } from './lib/machineKeys'
import { saveMachine } from './lib/machines'
import { authSession, authUser } from './test/betterAuth'
import { memoryKeyStore } from './test/deviceKeyStore'
import { testMachine } from './test/machineKey'
import { memoryMachineKeyStore } from './test/machineKeyStore'
import { server } from './test/msw'

// Vite turns `?url` imports into the asset's URL; Bun would hand the root route the stylesheet's module instead.
mock.module('./styles.css?url', () => ({ default: '/styles.css' }))
const { getRouter } = await import('./router')

const user = { id: 'u1', email: 'u1@example.com', name: 'U' }
/** A machine saved from a connect link, and one the account lists, whose key this browser already confirmed. */
const [saved, account] = [testMachine(), testMachine()]

/** Whether the fake server holds a session for the page's cookie. */
let signedIn = true

// Every test here reads the session, and most read the machine list, so these answer by default.
afterEach(() => {
  deviceKeyStores.default = indexedDbKeyStore
  machineKeyStores.default = indexedDbMachineKeyStore
})

beforeEach(() => {
  signedIn = true
  deviceKeyStores.default = memoryKeyStore().store
  const pinnedAt = '2026-11-01T12:00:00.000Z'
  machineKeyStores.default = memoryMachineKeyStore({
    [account.id]: { publicKey: account.publicKey, pinnedAt, source: 'confirmed' },
  }).store
  saveMachine({ id: saved.id, name: 'Laptop', key: 'k1', fingerprint: saved.fingerprint })
  server.use(
    http.get('*/api/auth/get-session', () =>
      HttpResponse.json(signedIn ? { user: authUser(user), session: authSession('s1', user.id) } : null),
    ),
    http.post('*/api/auth/sign-in/email', () => {
      signedIn = true
      return HttpResponse.json({ redirect: false, token: 't1', user: authUser(user) })
    }),
    http.post('*/api/auth/sign-out', () => {
      signedIn = false
      return HttpResponse.json({ success: true })
    }),
    http.get('*/api/machines', () => HttpResponse.json({ machines: [] })),
    // Each machine answers its own key, which the page checks before it opens any socket.
    http.get(`*/m/:machineId${routes.system.machineKey.path}`, ({ params }) => {
      const machine = [saved, account].find((m) => m.id === params.machineId)
      return machine ? HttpResponse.json({ publicKey: machine.publicKey }) : new HttpResponse(null, { status: 404 })
    }),
  )
})

/**
 * The app's router over the generated route tree, starting at `path`. Its shell, the prerendered `<html>` document
 * with an inline boot script that the browser gets from `index.html`, can't be created on the client (React warns
 * about the script), so the test renders into happy-dom's body with a shell that does its one other job: providing
 * the router's query client.
 */
function appRouter(path: string) {
  const router = getRouter(createMemoryHistory({ initialEntries: [path] }))
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
function quietMachine(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  server.use(ws.link(`*/m/:machineId${routes.sockets.events.path}`).addEventListener('connection', () => resolve()))
  return promise
}

/** Loads `path` in the app's router, renders it, and returns the router. */
async function show(path: string, router = appRouter(path)) {
  render(<RouterProvider router={router} />)
  await act(() => router.load())
  return router
}

/** Where the router landed after loading `path` and following any redirects. */
async function land(path: string) {
  const router = appRouter(path)
  await router.load()
  return router.state.location
}

describe('client routes', () => {
  test('unknown paths show not found, under a machine inside its page', async () => {
    const connected = quietMachine()
    await show(`/m/${saved.id}/w/ws1/unknown`)
    expect(await screen.findByText('Page not found.')).toBeInTheDocument()
    expect(screen.getByText('Laptop')).toBeInTheDocument()
    await connected
  })

  test('an unknown path outside a machine shows not found', async () => {
    await show('/nope')
    expect(await screen.findByText('Page not found.')).toBeInTheDocument()
  })

  test('known paths render their page, not the not-found view', async () => {
    await show('/')
    expect(await screen.findByRole('heading', { name: 'Your machines' })).toBeInTheDocument()
    expect(screen.queryByText('Page not found.')).not.toBeInTheDocument()
    cleanup()

    const connected = quietMachine()
    await show(`/m/${saved.id}/w/ws1`)
    expect((await screen.findAllByText('Connecting to the host…')).length).toBeGreaterThan(0)
    expect(screen.queryByText('Page not found.')).not.toBeInTheDocument()
    await connected
  })

  test('a machine saved from a connect link sends its key with a device proof, and an unapproved browser sees its fingerprint', async () => {
    const firstMessages: string[] = []
    server.use(
      ws.link(`*/m/${saved.id}${routes.sockets.events.path}`).addEventListener('connection', ({ client }) =>
        client.addEventListener(
          'message',
          (event) => {
            firstMessages.push(String(event.data))
            client.close(4403, 'device not approved')
          },
          { once: true },
        ),
      ),
    )
    const { fingerprint } = await loadDeviceKey(deviceKeyStores.default)
    await show(`/m/${saved.id}`)
    await waitFor(() => expect(firstMessages.length).toBeGreaterThan(0))
    expect(JSON.parse(firstMessages[0] ?? '')).toEqual({ type: 'auth', key: 'k1', device: expect.any(String) })
    expect((await screen.findAllByText(fingerprint)).length).toBeGreaterThan(0)
  })

  test('a machine with no key here opens through the account when listed, and is not linked otherwise', async () => {
    const at = '2026-10-30T12:00:00.000Z'
    const listed = {
      machineId: account.id,
      name: 'Desktop',
      createdAt: at,
      lastOpenedAt: at,
      online: true,
      remoteOff: false,
    }
    const firstMessages: string[] = []
    const ticketsFor: string[] = []
    const expiresAt = new Date(Date.now() + 60_000).toISOString()
    server.use(
      http.get('*/api/machines', () => HttpResponse.json({ machines: [listed] })),
      http.post('*/api/machines/:machineId/relay-ticket', ({ params }) => {
        ticketsFor.push(String(params.machineId))
        return HttpResponse.json({ ticket: 'fake.relay.ticket', expiresAt })
      }),
      ws
        .link(`*/m/${account.id}${routes.sockets.events.path}`)
        .addEventListener('connection', ({ client }) =>
          client.addEventListener('message', (event) => firstMessages.push(String(event.data)), { once: true }),
        ),
    )
    await show(`/m/${account.id}`)
    expect((await screen.findAllByText('Desktop')).length).toBeGreaterThan(0)
    await waitFor(() => expect(firstMessages).toHaveLength(1))
    // The first message asks to be judged by the account's ticket and carries this browser's device proof.
    expect(JSON.parse(firstMessages[0] ?? '')).toEqual({ type: 'auth', account: true, device: expect.any(String) })
    // The events socket asked for its own ticket for this machine before it opened.
    expect(ticketsFor[0]).toBe(account.id)
    cleanup()

    await show('/m/other-machine')
    expect(await screen.findByText("This machine isn't linked to your account.")).toBeInTheDocument()
  })

  test('pages share the root query client', async () => {
    const router = appRouter('/')
    // Stands in for a page that uses Query.
    router.routesById['/'].options.component = function QueryProbe() {
      return useQueryClient() === router.options.context.queryClient ? 'shared query client' : 'another query client'
    }
    await show('/', router)
    expect(await screen.findByText('shared query client')).toBeInTheDocument()
  })
})

describe('session guard', () => {
  test('signed out, guarded pages go to sign-in with the original path, and open pages still load', async () => {
    signedIn = false
    for (const path of ['/', '/m/x/w/y?tab=2']) {
      const { pathname, search } = await land(path)
      expect({ pathname, search }).toEqual({ pathname: '/auth/sign-in', search: { redirect: path } })
    }
    expect((await land('/auth?redirect=%2Fm%2Fx')).href).toBe('/auth/sign-in?redirect=%2Fm%2Fx')
    for (const open of ['/auth/sign-in', '/nope', '/sign-in', '/sign-up']) {
      expect((await land(open)).pathname).toBe(open)
    }
    await show('/sign-up')
    expect(await screen.findByText('Page not found.')).toBeInTheDocument()
  })

  test('the auth pages share the branded frame, with the page title as the only main heading', async () => {
    signedIn = false
    for (const [path, title] of [
      ['/auth/sign-in', 'Sign in'],
      ['/auth/sign-up', 'Create an account'],
    ]) {
      await show(path)
      expect(await screen.findByRole('heading', { level: 1, name: title })).toBeInTheDocument()
      expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
      expect(screen.getByText(PRODUCT_NAME)).toBeInTheDocument()
      expect(screen.getByText(PRODUCT_TAGLINE)).toBeInTheDocument()
      cleanup()
    }
  })

  test('signing in lands on the redirect when it is safe, and home otherwise', async () => {
    signedIn = false
    const router = await show(`/auth/sign-in?redirect=%2Fm%2F${saved.id}`)
    expect(router.state.location.pathname).toBe('/auth/sign-in')
    const connected = quietMachine()
    await act(async () => {
      expect(await signInWithEmail(router.options.context.queryClient, user.email, 'pw-old')).toBeNull()
    })
    // The sign-in hands the cache to the new user, which reruns the guards.
    await waitFor(() => expect(router.state.location.pathname).toBe(`/m/${saved.id}`))
    // The page checks the machine's key before it mounts the machine and connects.
    expect((await screen.findAllByText('Connecting to the host…')).length).toBeGreaterThan(0)
    await connected

    for (const unsafe of ['https://evil.example', '//evil.example', '/\\evil.example', '/auth/sign-up']) {
      expect((await land(`/auth/sign-in?redirect=${encodeURIComponent(unsafe)}`)).href).toBe('/')
    }
    expect((await land('/auth/sign-in')).href).toBe('/')
  })

  test('sign-up is open when signed out, links to sign-in with the redirect, and is skipped when signed in', async () => {
    signedIn = false
    await show('/auth/sign-up?redirect=%2Fm%2Fx')
    expect(await screen.findByRole('heading', { name: 'Create an account' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Sign in instead' })).toHaveAttribute(
      'href',
      '/auth/sign-in?redirect=%2Fm%2Fx',
    )

    signedIn = true
    expect((await land(`/auth/sign-up?redirect=%2Fm%2F${saved.id}`)).pathname).toBe(`/m/${saved.id}`)
    expect((await land('/auth/sign-up?redirect=https%3A%2F%2Fevil.example')).href).toBe('/')
  })

  test('sign-in links to sign-up with the redirect', async () => {
    signedIn = false
    await show('/auth/sign-in?redirect=%2Fm%2Fx')
    expect(await screen.findByRole('link', { name: 'Create an account' })).toHaveAttribute(
      'href',
      '/auth/sign-up?redirect=%2Fm%2Fx',
    )
  })

  test('signing out from the home page lands on sign-in', async () => {
    const router = await show('/')
    expect(router.state.location.pathname).toBe('/')
    await act(() => signOut(router.options.context.queryClient))
    await waitFor(() => expect(router.state.location.pathname).toBe('/auth/sign-in'))
  })
})

/** Keeps `token` for `page`, as `getRouter()` does when the browser opens that page's emailed link. */
function openEmailLink(page: EmailLinkPage, token: string) {
  const location = { pathname: `/auth/${page}`, search: '', hash: `#token=${token}` }
  acceptEmailLinkToken({ location, history: { state: null, replaceState() {} } })
}

describe('email pages', () => {
  test('sign-in links to forgot password and to the resend form', async () => {
    signedIn = false
    await show('/auth/sign-in')
    expect(await screen.findByRole('link', { name: 'Forgot your password?' })).toHaveAttribute(
      'href',
      '/auth/forgot-password',
    )
    expect(screen.getByRole('link', { name: "Didn't get the verification email?" })).toHaveAttribute(
      'href',
      '/auth/verify-email',
    )
  })

  test('sign-up offers to send the link again', () => {
    render(<CheckInbox email="ada@example.com" footer={null} />)
    expect(screen.getByText('ada@example.com')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send the link again' })).toBeEnabled()
  })

  test('verify email verifies with a token, and takes it once', async () => {
    signedIn = false
    // The server answers once the test has seen the page waiting for it.
    let answer = () => {}
    const answered = new Promise<void>((resolve) => (answer = resolve))
    server.use(
      http.get('*/api/auth/verify-email', async () => {
        await answered
        return HttpResponse.json({ status: true, user: null })
      }),
    )
    openEmailLink('verify-email', 'abc')
    await show('/auth/verify-email')
    expect(await screen.findByRole('heading', { name: 'Verifying your email address' })).toBeInTheDocument()
    answer()
    expect(await screen.findByRole('heading', { name: 'Email verified' })).toBeInTheDocument()
    // The page took the token, so a second visit, like a reload, finds none.
    expect(takeEmailLinkToken('verify-email')).toBeNull()
  })

  test('verify email without a token offers only the resend form, and stays when signed in', async () => {
    signedIn = false
    await show('/auth/verify-email')
    expect(await screen.findByRole('heading', { name: 'Verify your email address' })).toBeInTheDocument()
    expect(screen.queryByText(/expired/)).not.toBeInTheDocument()
    expect(screen.getAllByRole('textbox')).toEqual([screen.getByLabelText('Email')])
    expect(screen.getByLabelText('Email')).toHaveAttribute('type', 'email')

    signedIn = true
    expect((await land('/auth/verify-email')).pathname).toBe('/auth/verify-email')
  })

  test('reset password asks for a new password with a token, and only on its own page', async () => {
    signedIn = false
    openEmailLink('reset-password', 't1')
    // Another page's link token is never handed to this one.
    await show('/auth/verify-email')
    expect(await screen.findByRole('heading', { name: 'Verify your email address' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Verifying your email address' })).not.toBeInTheDocument()
  })

  test('reset password with a token asks for the new password', async () => {
    signedIn = false
    openEmailLink('reset-password', 't1')
    await show('/auth/reset-password')
    expect(await screen.findByRole('heading', { name: 'Choose a new password' })).toBeInTheDocument()
    const password = screen.getByLabelText('New password')
    expect(password).toHaveAttribute('autocomplete', 'new-password')
    expect(password).toHaveAttribute('name', 'password')
  })

  test('reset password without a token says the link expired, and stays when signed in', async () => {
    signedIn = false
    await show('/auth/reset-password')
    expect(await screen.findByText('This link has expired or is no longer valid.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Send a new reset link' })).toHaveAttribute('href', '/auth/forgot-password')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument()

    signedIn = true
    expect((await land('/auth/reset-password')).pathname).toBe('/auth/reset-password')
  })

  test('forgot password is a one-field form when signed out, and a signed-in visit goes home', async () => {
    signedIn = false
    await show('/auth/forgot-password')
    expect(await screen.findByLabelText('Email')).toHaveAttribute('type', 'email')
    expect(screen.getAllByRole('textbox')).toHaveLength(1)

    signedIn = true
    expect((await land('/auth/forgot-password')).href).toBe('/')
  })
})
