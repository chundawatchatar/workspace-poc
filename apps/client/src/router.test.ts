import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { useQueryClient } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { signInWithEmail } from './lib/auth'
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

/** Answers Better Auth's session and sign-in endpoints. */
async function fakeFetch(input: RequestInfo | URL) {
  const path = new URL(String(input instanceof Request ? input.url : input), location.origin).pathname
  if (path === '/api/auth/sign-in/email') signedIn = true
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
        pathname: '/sign-in',
        search: { redirect: path },
      })
    }
    expect(await render('/sign-in')).toContain('Sign in')
    expect(await render('/nope')).toContain('Page not found.')
  })

  test('signing in lands on the redirect when it is safe, and home otherwise', async () => {
    signedIn = false
    const router = await land('/sign-in?redirect=%2Fm%2Fsaved-machine')
    expect(router.state.location.pathname).toBe('/sign-in')
    await signInWithEmail(router.options.context.queryClient, 'u1@example.com', 'pw')
    // The sign-in hands the cache to the new user, which reruns the guards.
    for (let i = 0; i < 100 && router.state.location.pathname === '/sign-in'; i++) await Bun.sleep(10)
    expect(router.state.location.pathname).toBe('/m/saved-machine')

    for (const unsafe of ['https://evil.example', '//evil.example', '/\\evil.example']) {
      expect((await land(`/sign-in?redirect=${encodeURIComponent(unsafe)}`)).state.location.href).toBe('/')
    }
    expect((await land('/sign-in')).state.location.href).toBe('/')
  })

  test('sign-up is open when signed out, links to sign-in with the redirect, and is skipped when signed in', async () => {
    signedIn = false
    expect((await land('/sign-up?redirect=%2Fm%2Fx')).state.location.pathname).toBe('/sign-up')
    const signUp = await render('/sign-up?redirect=%2Fm%2Fx')
    expect(signUp).toContain('Create an account')
    expect(signUp).toContain('href="/sign-in?redirect=%2Fm%2Fx"')
    expect(await render('/sign-in?redirect=%2Fm%2Fx')).toContain('href="/sign-up?redirect=%2Fm%2Fx"')

    signedIn = true
    expect((await land('/sign-up?redirect=%2Fm%2Fsaved-machine')).state.location.pathname).toBe('/m/saved-machine')
    expect((await land('/sign-up?redirect=https%3A%2F%2Fevil.example')).state.location.href).toBe('/')
  })
})
