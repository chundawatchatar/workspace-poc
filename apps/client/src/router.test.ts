import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { PRODUCT_NAME, PRODUCT_TAGLINE } from '@orch/ui/brand'
import { useQueryClient } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { createElement } from 'react'
import type { Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { signInWithEmail, signOut } from './lib/auth'
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
    expect(home).toContain('Laptop')
    expect(home).not.toContain('Page not found.')

    const workspace = await render('/m/saved-machine/w/ws1')
    expect(workspace).toContain('Connecting to the host')
    expect(workspace).not.toContain('Page not found.')

    expect(await render('/m/other-machine')).toContain('linked in this browser.')
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

/** Every request the email pages sent: the path, the query and the JSON body. */
const emailRequests: { path: string; search: string; body: Record<string, string> | null }[] = []
/** The status the fake server answers each email endpoint with, by path; 200 when unset. */
const emailStatus: Record<string, number> = {}
let sessionReads = 0

/** Answers the session and the endpoints the email pages use, like the cloud server. */
async function emailFetch(input: RequestInfo | URL, init?: RequestInit) {
  const url = new URL(String(input instanceof Request ? input.url : input), location.origin)
  if (url.pathname === '/api/auth/get-session') {
    sessionReads++
    const user = { id: 'u1', email: 'u1@example.com', name: 'U' }
    return Response.json(signedIn ? { user, session: {} } : null)
  }
  const body = init?.body ? JSON.parse(String(init.body)) : null
  emailRequests.push({ path: url.pathname, search: url.search, body })
  await Bun.sleep(30)
  const status = emailStatus[url.pathname] ?? 200
  if (status !== 200) {
    const code = { 400: 'INVALID_TOKEN', 401: 'TOKEN_EXPIRED', 429: 'TOO_MANY_REQUESTS' }[status as 400 | 401 | 429]
    return Response.json({ code, message: 'Refused' }, { status })
  }
  // A password reset ends every session of the account.
  if (url.pathname === '/api/auth/reset-password') signedIn = false
  if (url.pathname === '/api/auth/sign-up/email') return Response.json({ token: null, user: { id: 'new' } })
  return Response.json({ status: true })
}

// These pages are driven in a DOM: they act on clicks, effects and timers, which rendering to a string never runs.
describe('email pages', () => {
  const rootRoute = getRouter(createMemoryHistory()).routesById.__root__
  const head = rootRoute.options.head
  /** The React roots of this test, unmounted after it. */
  const roots: Root[] = []
  let createRoot: typeof import('react-dom/client').createRoot

  beforeAll(async () => {
    GlobalRegistrator.register({ url: 'http://localhost:3220/' })
    // React DOM checks which events the browser supports as it loads, so it must load once the DOM is up.
    ;({ createRoot } = await import('react-dom/client'))
    globalThis.fetch = emailFetch as typeof fetch
    // React waits for the stylesheet to load before it shows the page, and Happy DOM never loads it.
    rootRoute.options.head = () => ({ meta: [] })
  })
  afterAll(async () => {
    rootRoute.options.head = head
    // Let React finish the work it scheduled before the DOM goes away.
    await Bun.sleep(50)
    await GlobalRegistrator.unregister()
    globalThis.location = { origin: 'http://localhost:3220' } as Location
    globalThis.fetch = fakeFetch as typeof fetch
  })
  afterEach(() => {
    for (const root of roots.splice(0)) root.unmount()
    emailRequests.length = 0
    for (const path of Object.keys(emailStatus)) delete emailStatus[path]
    sessionReads = 0
  })

  /** Opens `url` as a browser would, through `getRouter()` and its browser history, and renders the app. */
  async function open(url: string) {
    history.replaceState(null, '', url)
    const router = getRouter()
    const root = createRoot(document)
    roots.push(root)
    root.render(createElement(RouterProvider, { router }))
    await until(() => router.state.status === 'idle' && heading() !== undefined)
    return router
  }

  test('a verify link leaves the address bar before the router starts, and verifies once', async () => {
    signedIn = true
    const router = await open('/auth/verify-email#token=abc')
    expect(location.href).toBe('http://localhost:3220/auth/verify-email')
    expect(router.state.location.href).toBe('/auth/verify-email')
    await until(() => heading() === 'Email verified')
    expect(emailRequests).toEqual([{ path: '/api/auth/verify-email', search: '?token=abc', body: null }])
    expect(link('Sign in')?.getAttribute('href')).toBe('/auth/sign-in')
    // Signed in, the page stays: it has no `leaveIfSignedIn`.
    expect(router.state.location.pathname).toBe('/auth/verify-email')

    // The same link opened again in this tab changes only the fragment.
    history.pushState(null, '', '/auth/verify-email#token=again')
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(location.hash).toBe('')
    await until(() => emailRequests.length === 2 && heading() === 'Email verified')
    expect(emailRequests[1]?.search).toBe('?token=again')
    expect(router.state.location.hash).toBe('')
  })

  test('a refused or missing verify token offers the resend form, which answers the same for any address', async () => {
    signedIn = false
    emailStatus['/api/auth/verify-email'] = 401
    await open('/auth/verify-email#token=old')
    await until(() => text().includes('This link has expired or is no longer valid.'))
    expect(document.querySelectorAll('input')).toHaveLength(1)
    expect(document.activeElement).toBe(document.querySelector('h1'))

    roots.splice(0).forEach((root) => void root.unmount())
    emailRequests.length = 0
    await open('/auth/verify-email')
    expect(text()).not.toContain('expired')
    expect(emailRequests).toEqual([])
    for (const email of ['known@example.com', 'nobody@example.com']) {
      type(input('email'), email)
      submit()
      await until(() =>
        text().includes(`If ${email} has an account that still needs verifying, we sent it a new link.`),
      )
      expect(input('email').value).toBe('')
    }
    expect(emailRequests.map((r) => [r.path, r.body?.email])).toEqual([
      ['/api/auth/send-verification-email', 'known@example.com'],
      ['/api/auth/send-verification-email', 'nobody@example.com'],
    ])
  })

  test('check your inbox sends the link again once per 30 seconds, and reports a rate limit', async () => {
    signedIn = false
    await open('/auth/sign-up')
    type(input('name'), 'Ada')
    type(input('email'), 'ada@example.com')
    type(input('password'), 'long enough')
    submit()
    await until(() => heading() === 'Check your inbox')

    // The cooldown's timer is caught here and run by hand; Bun's fake timers would also stop the fake server.
    const cooldowns: (() => void)[] = []
    const realSetTimeout = globalThis.setTimeout
    const timers = spyOn(globalThis, 'setTimeout').mockImplementation(((run: () => void, ms?: number) => {
      if (ms !== 30_000) return realSetTimeout(run, ms)
      cooldowns.push(run)
      return 0
    }) as typeof setTimeout)
    const resend = button('Send the link again')
    try {
      resend.click()
      await until(() => resend.getAttribute('aria-busy') === 'true')
      resend.click()
      await until(() => text().includes('We sent another link.'))
      expect(document.querySelectorAll('[role="status"]')).toHaveLength(2)
      expect(resend.disabled).toBe(true)
      resend.click()
      expect(cooldowns).toHaveLength(1)
      await Bun.sleep(50)
      expect(resend.disabled).toBe(true)
      cooldowns[0]?.()
      await until(() => !resend.disabled)
    } finally {
      timers.mockRestore()
    }
    const resends = emailRequests.filter((r) => r.path === '/api/auth/send-verification-email')
    expect(resends.map((r) => r.body)).toEqual([{ email: 'ada@example.com' }])

    emailStatus['/api/auth/send-verification-email'] = 429
    resend.click()
    await until(() => document.querySelector('[role="alert"]') !== null)
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'Too many attempts. Wait a minute and try again.',
    )
    expect(resend.disabled).toBe(false)
  })

  test('forgot password checks the address, answers the same for any account and reports a rate limit', async () => {
    signedIn = false
    await open('/auth/sign-in')
    expect(link('Forgot your password?')?.getAttribute('href')).toBe('/auth/forgot-password')
    expect(link("Didn't get the verification email?")?.getAttribute('href')).toBe('/auth/verify-email')
    roots.splice(0).forEach((root) => void root.unmount())

    await open('/auth/forgot-password')
    type(input('email'), 'not-an-email')
    submit()
    await until(() => text().includes('Enter a valid email address.'))
    expect(emailRequests).toEqual([])

    for (const email of ['known@example.com', 'nobody@example.com']) {
      type(input('email'), email)
      submit()
      await until(() => text().includes(`If an account exists for ${email}, we sent a link`))
      expect(input('email').value).toBe('')
      expect(document.activeElement).toBe(document.querySelector('h1'))
    }
    expect(emailRequests.map((r) => [r.path, r.body?.email])).toEqual([
      ['/api/auth/request-password-reset', 'known@example.com'],
      ['/api/auth/request-password-reset', 'nobody@example.com'],
    ])

    emailStatus['/api/auth/request-password-reset'] = 429
    type(input('email'), 'busy@example.com')
    submit()
    await until(() => text().includes('Too many attempts. Wait a minute and try again.'))
    expect(input('email').value).toBe('busy@example.com')
  })

  test('a reset link sets the new password, signs this browser out, and a refused or missing token says so', async () => {
    signedIn = true
    const router = await open('/auth/reset-password#token=t1')
    expect(location.href).toBe('http://localhost:3220/auth/reset-password')
    expect(input('password').getAttribute('autocomplete')).toBe('new-password')
    type(input('password'), 'short')
    submit()
    await until(() => text().includes('Use at least 8 characters.'))
    expect(emailRequests).toEqual([])

    const reads = sessionReads
    type(input('password'), 'a brand new passphrase')
    submit()
    await until(() => heading() === 'Password changed')
    expect(emailRequests).toEqual([
      { path: '/api/auth/reset-password', search: '', body: { token: 't1', newPassword: 'a brand new passphrase' } },
    ])
    expect(sessionReads).toBeGreaterThan(reads)
    expect(router.options.context.queryClient.getQueryData(['session'])).toBeNull()
    expect(link('Sign in with your new password')?.getAttribute('href')).toBe('/auth/sign-in')
    expect(router.state.location.pathname).toBe('/auth/reset-password')

    roots.splice(0).forEach((root) => void root.unmount())
    emailStatus['/api/auth/reset-password'] = 400
    await open('/auth/reset-password#token=used')
    type(input('password'), 'a brand new passphrase')
    submit()
    await until(() => text().includes('This link has expired or is no longer valid.'))
    expect(document.querySelector('input')).toBeNull()
    expect(link('Send a new reset link')?.getAttribute('href')).toBe('/auth/forgot-password')

    roots.splice(0).forEach((root) => void root.unmount())
    await open('/auth/reset-password')
    expect(text()).toContain('This link has expired or is no longer valid.')
    expect(document.querySelector('input')).toBeNull()
  })

  test('a signed-in visit to forgot password goes home', async () => {
    signedIn = true
    const router = await open('/auth/forgot-password')
    await until(() => router.state.location.pathname === '/')
  })
})

/** Resolves once `check` holds, or fails after about two seconds. */
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return
    await Bun.sleep(10)
  }
  throw new Error(`timed out on: ${check}`)
}

const heading = () => document.querySelector('h1')?.textContent ?? undefined
const text = () => document.body.textContent ?? ''
const input = (name: string) => document.querySelector(`input[name="${name}"]`) as HTMLInputElement
const link = (label: string) => [...document.querySelectorAll('a')].find((a) => a.textContent === label)
const button = (label: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement

/** Types `value` into `field` the way React notices: through the native setter, then an `input` event. */
function type(field: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value)
  field.dispatchEvent(new Event('input', { bubbles: true }))
}

/** Presses Enter in the form, which submits it. */
function submit() {
  document.querySelector('form')?.requestSubmit()
}
