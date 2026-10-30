import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { PRODUCT_NAME, PRODUCT_TAGLINE } from '@orch/ui/brand'
import { useQueryClient } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { CheckInbox } from './components/CheckInbox'
import { signInWithEmail, signOut } from './lib/auth'
import { acceptEmailLinkToken, type EmailLinkPage, takeEmailLinkToken } from './lib/emailLink'
import { saveMachine } from './lib/machines'
import { installMemoryStorage, uninstallMemoryStorage } from './lib/testStorage'

// Vite turns `?url` imports into the asset's URL; Bun would hand the root route the stylesheet's module instead.
mock.module('./styles.css?url', () => ({ default: '/styles.css' }))
const { getRouter } = await import('./router')

/** Loads `path` in the router over the generated route tree and renders it to HTML. */
async function render(path: string, router = getRouter(createMemoryHistory({ initialEntries: [path] }))) {
  await router.load()
  return renderToString(createElement(RouterProvider, { router }))
}

/** Whether the fake server holds a session for the page's cookie. */
let signedIn = true

/** Answers Better Auth's session, sign-in and sign-out endpoints. */
async function fakeFetch(input: RequestInfo | URL) {
  const path = new URL(String(input instanceof Request ? input.url : input), location.origin).pathname
  if (path === '/api/auth/sign-in/email') signedIn = true
  if (path === '/api/auth/sign-out') {
    signedIn = false
    return Response.json({ success: true })
  }
  const user = { id: 'u1', email: 'u1@example.com', name: 'U' }
  if (path === '/api/auth/get-session') return Response.json(signedIn ? { user, session: {} } : null)
  return Response.json(signedIn ? { token: 't', user } : {}, { status: signedIn ? 200 : 401 })
}

/**
 * Loads `path` the way the browser does, following redirects, and returns where the router landed. The router acts
 * as a server without `window`, which answers a redirect instead of following it, so a stand-in `window` is put up.
 */
async function land(path: string) {
  const win = { origin: location.origin, addEventListener() {}, removeEventListener() {} }
  Object.assign(globalThis, { window: win })
  try {
    const router = getRouter(createMemoryHistory({ initialEntries: [path] }))
    router.update({ ...router.options, isServer: false })
    await router.load()
    return router
  } finally {
    Reflect.deleteProperty(globalThis, 'window')
  }
}

const realLocation = globalThis.location
const realFetch = globalThis.fetch
afterAll(() => {
  globalThis.location = realLocation
  globalThis.fetch = realFetch
  uninstallMemoryStorage()
  uninstallMemoryStorage('sessionStorage')
})

beforeAll(() => {
  installMemoryStorage()
  installMemoryStorage('sessionStorage')
  // The page's origin stands in for the cloud server.
  globalThis.location = { origin: 'http://localhost:3220' } as Location
  globalThis.fetch = fakeFetch as typeof fetch
  saveMachine({ id: 'saved-machine', name: 'Laptop', key: 'k1' })
})

afterEach(() => {
  signedIn = true
})

describe('client routes', () => {
  test('unknown paths show not found, under a machine inside its page', async () => {
    const underMachine = await render('/m/saved-machine/w/ws1/unknown')
    expect(underMachine).toContain('Page not found.')
    expect(underMachine).toContain('Laptop')

    expect(await render('/nope')).toContain('Page not found.')
  })

  test('known paths render their page, not the not-found view', async () => {
    const home = await render('/')
    expect(home).toContain('Your machines')
    expect(home).not.toContain('Page not found.')

    const workspace = await render('/m/saved-machine/w/ws1')
    expect(workspace).toContain('Connecting to the host')
    expect(workspace).not.toContain('Page not found.')

    expect(await render('/m/other-machine')).toContain('Open the connect link on this device')
  })

  test('pages share the root query client', async () => {
    const router = getRouter(createMemoryHistory({ initialEntries: ['/'] }))
    const home = router.routesById['/']
    const page = home.options.component
    // Stands in for a page that uses Query.
    home.options.component = function QueryProbe() {
      return useQueryClient() === router.options.context.queryClient ? 'shared query client' : 'another query client'
    }
    try {
      expect(await render('/', router)).toContain('shared query client')
    } finally {
      home.options.component = page
    }
  })
})

describe('session guard', () => {
  test('signed out, guarded pages go to sign-in with the original path, and open pages still load', async () => {
    signedIn = false
    for (const path of ['/', '/m/x/w/y?tab=2']) {
      const { location } = (await land(path)).state
      expect({ pathname: location.pathname, search: location.search }).toEqual({
        pathname: '/auth/sign-in',
        search: { redirect: path },
      })
    }
    expect((await land('/auth?redirect=%2Fm%2Fx')).state.location.href).toBe('/auth/sign-in?redirect=%2Fm%2Fx')
    expect(await render('/auth/sign-in')).toContain('Sign in')
    expect(await render('/nope')).toContain('Page not found.')
    for (const old of ['/sign-in', '/sign-up']) expect(await render(old)).toContain('Page not found.')
  })

  test('the auth pages share the branded frame, with the page title as the only heading', async () => {
    signedIn = false
    for (const path of ['/auth/sign-in', '/auth/sign-up']) {
      const html = await render(path)
      expect(html).toMatch(/<span aria-hidden="true"[^>]*><svg [^>]*aria-hidden="true"/)
      expect(html).toContain(PRODUCT_NAME)
      expect(html).toContain(PRODUCT_TAGLINE)
      expect(html.match(/<h1\b/g)).toHaveLength(1)
    }
  })

  test('signing in lands on the redirect when it is safe, and home otherwise', async () => {
    signedIn = false
    const router = await land('/auth/sign-in?redirect=%2Fm%2Fsaved-machine')
    expect(router.state.location.pathname).toBe('/auth/sign-in')
    await signInWithEmail(router.options.context.queryClient, 'u1@example.com', 'pw')
    // The sign-in hands the cache to the new user, which reruns the guards.
    for (let i = 0; i < 100 && router.state.location.pathname === '/auth/sign-in'; i++) await Bun.sleep(10)
    expect(router.state.location.pathname).toBe('/m/saved-machine')

    for (const unsafe of ['https://evil.example', '//evil.example', '/\\evil.example', '/auth/sign-up']) {
      expect((await land(`/auth/sign-in?redirect=${encodeURIComponent(unsafe)}`)).state.location.href).toBe('/')
    }
    expect((await land('/auth/sign-in')).state.location.href).toBe('/')
  })

  test('sign-up is open when signed out, links to sign-in with the redirect, and is skipped when signed in', async () => {
    signedIn = false
    expect((await land('/auth/sign-up?redirect=%2Fm%2Fx')).state.location.pathname).toBe('/auth/sign-up')
    const signUp = await render('/auth/sign-up?redirect=%2Fm%2Fx')
    expect(signUp).toContain('Create an account')
    expect(signUp).toContain('href="/auth/sign-in?redirect=%2Fm%2Fx"')
    expect(await render('/auth/sign-in?redirect=%2Fm%2Fx')).toContain('href="/auth/sign-up?redirect=%2Fm%2Fx"')

    signedIn = true
    expect((await land('/auth/sign-up?redirect=%2Fm%2Fsaved-machine')).state.location.pathname).toBe('/m/saved-machine')
    expect((await land('/auth/sign-up?redirect=https%3A%2F%2Fevil.example')).state.location.href).toBe('/')
  })

  test('signing out from the home page lands on sign-in', async () => {
    const router = await land('/')
    expect(router.state.location.pathname).toBe('/')
    await signOut(router.options.context.queryClient)
    for (let i = 0; i < 100 && router.state.location.pathname === '/'; i++) await Bun.sleep(10)
    expect(router.state.location.pathname).toBe('/auth/sign-in')
  })
})

/** Keeps `token` for `page`, as `getRouter()` does when the browser opens that page's emailed link. */
function openEmailLink(page: EmailLinkPage, token: string) {
  const location = { pathname: `/auth/${page}`, search: '', hash: `#token=${token}` }
  acceptEmailLinkToken({ location, history: { state: null, replaceState() {} } })
}

/** How many `<input>` elements `html` has. */
const inputs = (html: string) => html.match(/<input\b/g)?.length ?? 0

describe('email pages', () => {
  test('sign-in links to forgot password and to the resend form, and sign-up offers to send the link again', async () => {
    signedIn = false
    const signIn = await render('/auth/sign-in')
    expect(signIn).toContain('href="/auth/forgot-password"')
    expect(signIn).toContain('href="/auth/verify-email"')

    const inbox = renderToString(createElement(CheckInbox, { email: 'ada@example.com', footer: null }))
    expect(inbox).toContain('ada@example.com')
    expect(inbox).toMatch(/<button type="button"[^>]*>Send the link again<\/button>/)
    expect(inbox).not.toMatch(/<button[^>]*\sdisabled=/)
  })

  test('verify email starts verifying with a token, offers only the resend form without one, and stays signed in', async () => {
    signedIn = false
    openEmailLink('verify-email', 'abc')
    expect(await render('/auth/verify-email')).toContain('Verifying your email address')
    // The page took the token, so a second visit, like a reload, finds none.
    expect(takeEmailLinkToken('verify-email')).toBeNull()

    const form = await render('/auth/verify-email')
    expect(form).toContain('Verify your email address')
    expect(form).not.toContain('expired')
    expect(inputs(form)).toBe(1)
    expect(form).toContain('type="email"')

    signedIn = true
    expect((await land('/auth/verify-email')).state.location.pathname).toBe('/auth/verify-email')
  })

  test('reset password asks for a new password with a token, says the link expired without one, and stays signed in', async () => {
    signedIn = false
    openEmailLink('reset-password', 't1')
    // Another page's link token is never handed to this one.
    expect(await render('/auth/verify-email')).not.toContain('Verifying')
    const form = await render('/auth/reset-password')
    expect(form).toContain('Choose a new password')
    expect(form).toMatch(/<input [^>]*autoComplete="new-password"/i)
    expect(form).toContain('name="password"')

    const expired = await render('/auth/reset-password')
    expect(expired).toContain('This link has expired or is no longer valid.')
    expect(expired).toContain('href="/auth/forgot-password"')
    expect(inputs(expired)).toBe(0)

    signedIn = true
    expect((await land('/auth/reset-password')).state.location.pathname).toBe('/auth/reset-password')
  })

  test('forgot password is a one-field form when signed out, and a signed-in visit goes home', async () => {
    signedIn = false
    const form = await render('/auth/forgot-password')
    expect(inputs(form)).toBe(1)
    expect(form).toContain('type="email"')

    signedIn = true
    expect((await land('/auth/forgot-password')).state.location.href).toBe('/')
  })
})
