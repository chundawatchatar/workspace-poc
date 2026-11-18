import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { PRODUCT_NAME, PRODUCT_TAGLINE } from '@orch/brand'
import { type E2eSocketOpen, machineSealedSocketPath, routes } from '@orch/shared'
import { useQueryClient } from '@tanstack/react-query'
import { act, cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http, ws } from 'msw'
import { signInWithEmail, signOut } from './lib/auth'
import { deviceKeyStores, loadDeviceKey } from './lib/deviceKey'
import { acceptEmailLinkToken, type EmailLinkPage, takeEmailLinkToken } from './lib/emailLink'
import { Route as homeRoute } from './routes/index'
import {
  account,
  appRouter,
  fakeSession,
  getRouter,
  installAppFakes,
  land,
  quietMachine,
  show,
  user,
  withTestShell,
} from './test/appRouter'
import { authSession, authUser } from './test/betterAuth'
import { server } from './test/msw'

/** The home page, which a test may swap for a probe; the route tree is shared by every router. */
const homeComponent = homeRoute.options.component

/** The access keys an older client kept in `localStorage`, from the connect links opened in this browser. */
function saveOldKey(machineId: string, key: string) {
  localStorage.setItem('orch-machines', JSON.stringify([{ id: machineId, name: 'Old', key, fingerprint: 'F' }]))
}

/** A router over the browser's own history, which `afterEach` lets go of. */
let browserRouter: ReturnType<typeof getRouter> | undefined

// Registered before the shared fakes, so the browser router lets go before they reset the address bar.
afterEach(() => {
  homeRoute.options.component = homeComponent
  browserRouter?.history.destroy()
  browserRouter = undefined
})
installAppFakes()

describe('client routes', () => {
  test('unknown paths show not found, under a machine inside its page', async () => {
    const connected = quietMachine(account.id)
    await show(`/m/${account.id}/w/ws1/unknown`)
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

    const connected = quietMachine(account.id)
    await show(`/m/${account.id}/w/ws1`)
    expect((await screen.findAllByText('Connecting to the host…')).length).toBeGreaterThan(0)
    expect(screen.queryByText('Page not found.')).not.toBeInTheDocument()
    await connected
  })

  test('a listed machine opens with relay tickets, never a key an older client saved, and an unlisted one is not linked', async () => {
    saveOldKey(account.id, 'k1')
    const opens: E2eSocketOpen[] = []
    const ticketsFor: string[] = []
    const keyHeaders: (string | null)[] = []
    server.use(
      // Sees every request to the machine, then lets the handlers above answer it.
      http.all('*/m/*', ({ request }) => void keyHeaders.push(request.headers.get('x-orch-access-key'))),
      http.post('*/api/machines/:machineId/relay-ticket', ({ params }) => {
        ticketsFor.push(String(params.machineId))
        return HttpResponse.json({
          ticket: 'fake.relay.ticket',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        })
      }),
      ws.link(`*${machineSealedSocketPath(account.id)}`).addEventListener('connection', ({ client }) =>
        client.addEventListener(
          'message',
          async (event) => {
            opens.push(await account.openSocket(event.data))
            client.close(4403, 'device not approved')
          },
          { once: true },
        ),
      ),
    )
    const { fingerprint } = await loadDeviceKey(deviceKeyStores.default)
    await show(`/m/${account.id}`)
    expect((await screen.findAllByText('Laptop')).length).toBeGreaterThan(0)
    await waitFor(() => expect(opens.length).toBeGreaterThan(0))
    // The sealed open asks to be judged by the account's ticket, which it carries, with this browser's device proof.
    expect(opens[0]).toEqual({
      path: routes.sockets.events.path,
      auth: { type: 'auth', account: true, device: expect.any(String) },
      ticket: 'fake.relay.ticket',
    })
    expect(ticketsFor[0]).toBe(account.id)
    expect(keyHeaders.length).toBeGreaterThan(0)
    expect(keyHeaders.every((header) => header === null)).toBe(true)
    // The machine refused this browser, which waits for approval there and shows its fingerprint to approve.
    expect((await screen.findAllByText(fingerprint)).length).toBeGreaterThan(0)
    cleanup()

    await show('/m/other-machine')
    expect(await screen.findByText("This machine isn't linked to your account.")).toBeInTheDocument()
  })

  test("starting the app removes the saved keys, and an old connect link's key leaves the address bar unused", async () => {
    const requests: string[] = []
    server.use(
      http.all('*', ({ request }) => {
        requests.push(`${request.url} ${JSON.stringify([...request.headers])}`)
      }),
    )
    saveOldKey(account.id, 'k1')
    localStorage.setItem('orch-theme', 'dark')
    const entry = { key: 'entry-1', __TSR_key: 'entry-1', __TSR_index: 0 }
    const link = `#machine=${account.id}&key=k1&fp=${account.fingerprint}`
    window.history.replaceState(entry, '', `/anything?q=1${link}`)

    browserRouter = withTestShell(getRouter())
    expect(Object.fromEntries(Object.entries(localStorage))).toEqual({ 'orch-theme': 'dark' })
    expect(window.location.href).toBe('http://localhost:3220/anything?q=1')
    expect(window.history.state).toEqual(entry)
    // The router starts where the link pointed, not on the machine's page.
    await show('/anything', browserRouter)
    expect(await screen.findByText('Page not found.')).toBeInTheDocument()
    expect(browserRouter.state.location.href).toBe('/anything?q=1')
    await waitFor(() => expect(requests.length).toBeGreaterThan(0))
    expect(requests.filter((request) => request.includes('k1'))).toEqual([])
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
    fakeSession.signedIn = false
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
    fakeSession.signedIn = false
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
    fakeSession.signedIn = false
    const router = await show(`/auth/sign-in?redirect=%2Fm%2F${account.id}`)
    expect(router.state.location.pathname).toBe('/auth/sign-in')
    const connected = quietMachine(account.id)
    await act(async () => {
      expect(await signInWithEmail(router.options.context.queryClient, user.email, 'pw-old')).toBeNull()
    })
    // The sign-in hands the cache to the new user, which reruns the guards.
    await waitFor(() => expect(router.state.location.pathname).toBe(`/m/${account.id}`))
    // The page checks the machine's key before it mounts the machine and connects.
    expect((await screen.findAllByText('Connecting to the host…')).length).toBeGreaterThan(0)
    await connected

    for (const unsafe of ['https://evil.example', '//evil.example', '/\\evil.example', '/auth/sign-up']) {
      expect((await land(`/auth/sign-in?redirect=${encodeURIComponent(unsafe)}`)).href).toBe('/')
    }
    expect((await land('/auth/sign-in')).href).toBe('/')
  })

  test('sign-up is open when signed out, links to sign-in with the redirect, and is skipped when signed in', async () => {
    fakeSession.signedIn = false
    await show('/auth/sign-up?redirect=%2Fm%2Fx')
    expect(await screen.findByRole('heading', { name: 'Create an account' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Sign in instead' })).toHaveAttribute(
      'href',
      '/auth/sign-in?redirect=%2Fm%2Fx',
    )

    fakeSession.signedIn = true
    expect((await land(`/auth/sign-up?redirect=%2Fm%2F${account.id}`)).pathname).toBe(`/m/${account.id}`)
    expect((await land('/auth/sign-up?redirect=https%3A%2F%2Fevil.example')).href).toBe('/')
  })

  test('sign-in links to sign-up with the redirect', async () => {
    fakeSession.signedIn = false
    await show('/auth/sign-in?redirect=%2Fm%2Fx')
    expect(await screen.findByRole('link', { name: 'Create an account' })).toHaveAttribute(
      'href',
      '/auth/sign-up?redirect=%2Fm%2Fx',
    )
  })

  test('a session that fails to read shows the error page, and Retry opens the page once it reads', async () => {
    // The boundary that catches the failure warns, and React logs the error it caught.
    spyOn(console, 'warn').mockImplementation(() => {})
    spyOn(console, 'error').mockImplementation(() => {})
    let status = 404
    let reads = 0
    let answer: Promise<void> | undefined
    server.use(
      http.get('*/api/auth/get-session', async () => {
        reads++
        if (status !== 200) return HttpResponse.json({ message: 'Not here' }, { status })
        await answer
        return HttpResponse.json({ user: authUser(user), session: authSession('s1', user.id) })
      }),
    )
    const failed = async (path: string) => {
      const router = appRouter(path)
      router.options.context.queryClient.setDefaultOptions({ queries: { retry: false } })
      await show(path, router)
      expect(await screen.findByText('Something went wrong.')).toBeInTheDocument()
      expect(screen.getByText("This page couldn't load. Try again in a moment.")).toBeInTheDocument()
      expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['Retry'])
      expect(document.body.textContent).not.toMatch(/Something went wrong!|Show Error|Reading the session|404|500/)
      return router
    }
    await failed('/settings/security')
    cleanup()

    status = 500
    const router = await failed('/')
    const click = userEvent.setup()
    // A retry that fails again reads the session anew, then leaves the page as it was, ready to try again.
    const before = reads
    await click.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled())
    expect(reads).toBe(before + 1)
    expect(screen.getByText('Something went wrong.')).toBeInTheDocument()

    status = 200
    let release = () => {}
    answer = new Promise<void>((resolve) => (release = resolve))
    await click.click(screen.getByRole('button', { name: 'Retry' }))
    expect(screen.getByRole('button', { name: 'Retry' })).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled()
    release()
    expect(await screen.findByRole('heading', { name: 'Your machines' })).toBeInTheDocument()
    expect(screen.queryByText('Something went wrong.')).not.toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/')
  })

  test('signing out from the home page lands on sign-in', async () => {
    const router = await show('/')
    expect(router.state.location.pathname).toBe('/')
    await act(() => signOut(router.options.context.queryClient))
    await waitFor(() => expect(router.state.location.pathname).toBe('/auth/sign-in'))
  })
})

/** Keeps `token` for `page`, as `getRouter()` does when the browser opens that page's emailed link. */
function openEmailLink(page: EmailLinkPage | 'verify-email', token: string) {
  const location = { pathname: `/auth/${page}`, search: '', hash: `#token=${token}` }
  acceptEmailLinkToken({ location, history: { state: null, replaceState() {} } })
}

describe('email pages', () => {
  test('sign-in links to forgot password and to nothing about verification', async () => {
    fakeSession.signedIn = false
    await show('/auth/sign-in')
    expect(await screen.findByRole('link', { name: 'Forgot your password?' })).toHaveAttribute(
      'href',
      '/auth/forgot-password',
    )
    expect(screen.queryByText(/verification/i)).not.toBeInTheDocument()
  })

  test('the removed verify-email page is not found, and its link token is never kept', async () => {
    fakeSession.signedIn = false
    openEmailLink('verify-email', 'abc')
    expect(takeEmailLinkToken('reset-password')).toBeNull()
    await show('/auth/verify-email')
    expect(await screen.findByText('Page not found.')).toBeInTheDocument()
  })

  test('reset password with a token asks for the new password', async () => {
    fakeSession.signedIn = false
    openEmailLink('reset-password', 't1')
    await show('/auth/reset-password')
    expect(await screen.findByRole('heading', { name: 'Choose a new password' })).toBeInTheDocument()
    const password = screen.getByLabelText('New password')
    expect(password).toHaveAttribute('autocomplete', 'new-password')
    expect(password).toHaveAttribute('name', 'password')
  })

  test('reset password without a token says the link expired, and stays when signed in', async () => {
    fakeSession.signedIn = false
    await show('/auth/reset-password')
    expect(await screen.findByText('This link has expired or is no longer valid.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Send a new reset link' })).toHaveAttribute('href', '/auth/forgot-password')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument()

    fakeSession.signedIn = true
    expect((await land('/auth/reset-password')).pathname).toBe('/auth/reset-password')
  })

  test('forgot password is a one-field form when signed out, and a signed-in visit goes home', async () => {
    fakeSession.signedIn = false
    await show('/auth/forgot-password')
    expect(await screen.findByLabelText('Email')).toHaveAttribute('type', 'email')
    expect(screen.getAllByRole('textbox')).toHaveLength(1)

    fakeSession.signedIn = true
    expect((await land('/auth/forgot-password')).href).toBe('/')
  })
})
