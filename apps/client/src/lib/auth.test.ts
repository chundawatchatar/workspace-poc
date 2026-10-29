import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { serverRoutes } from '@orch/shared'
import { focusManager, QueryClient, QueryObserver } from '@tanstack/react-query'
import {
  accountKey,
  accountQuery,
  authClient,
  refetchSession,
  type SessionUser,
  safeRedirect,
  sessionQuery,
  signInWithEmail,
  signOut,
  signUpWithEmail,
  watchIdentity,
} from './auth'
import { readPendingMachineLink, setPendingMachineLink } from './pendingLink'
import { serverQuery } from './server'
import { installMemoryStorage, uninstallMemoryStorage } from './testStorage'

const userA: SessionUser = { id: 'user-a', email: 'a@example.com', name: 'Ada' }
const userB: SessionUser = { id: 'user-b', email: 'b@example.com', name: 'Bob' }

/** The fake server's state: who the cookie belongs to, and every request it got. */
const server = { user: null as SessionUser | null, requests: [] as { url: string; init?: RequestInit }[] }

const realFetch = globalThis.fetch
const realLocation = globalThis.location

/** Answers Better Auth's endpoints the way the cloud server would for `server.user`. */
async function fakeFetch(input: RequestInfo | URL, init?: RequestInit) {
  const url = String(input instanceof Request ? input.url : input)
  server.requests.push({ url, init })
  const path = new URL(url, location.origin).pathname
  if (path === '/api/auth/get-session') {
    const user = server.user
    return Response.json(user && { user: { ...user, emailVerified: true }, session: { token: `token-${user.id}` } })
  }
  if (path === '/api/auth/sign-out') {
    server.user = null
    return Response.json({ success: true })
  }
  if (path === '/api/auth/sign-in/email') {
    const { email } = JSON.parse(String(init?.body))
    if (email === 'unverified@example.com') return Response.json({ code: 'EMAIL_NOT_VERIFIED' }, { status: 403 })
    server.user = [userA, userB].find((u) => u.email === email) ?? null
    return server.user ? Response.json({ token: 't', user: server.user }) : Response.json({}, { status: 401 })
  }
  if (path === '/api/auth/sign-up/email') {
    // Like the cloud server: a new and a taken address get the same answer, and no session either way.
    const { email } = JSON.parse(String(init?.body))
    if (email === 'busy@example.com') return Response.json({ message: 'Too many requests' }, { status: 429 })
    if (email === 'broken@example.com') return Response.json({ message: 'Oops' }, { status: 500 })
    return Response.json({ token: null, user: { id: 'new', email, name: 'New' } })
  }
  if (path === '/api/me') {
    if (server.user) return Response.json(server.user)
    return Response.json({ error: { code: 'unauthorized', message: 'Sign in first.' } }, { status: 401 })
  }
  if (path === '/api/auth/list-sessions') {
    return Response.json(server.user ? [{ token: `token-${server.user.id}`, userAgent: 'test' }] : [])
  }
  return Response.json({ error: { code: 'not_found', message: 'Not found.' } }, { status: 404 })
}

/** Resolves once `check` holds, or fails after a second. */
async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10))
  expect(check()).toBe(true)
}

/** A query client with the identity watcher, signed in as `user`. */
async function setup(user: SessionUser | null) {
  server.user = user
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  let changes = 0
  watchIdentity(queryClient, () => changes++)
  await refetchSession(queryClient)
  return { queryClient, changes: () => changes }
}

/** Everything the cache holds, keys and data, as one string to search. */
function cacheDump(queryClient: QueryClient) {
  return JSON.stringify(
    queryClient
      .getQueryCache()
      .getAll()
      .map((q) => [q.queryKey, q.state.data]),
  )
}

beforeAll(() => {
  installMemoryStorage('sessionStorage')
  globalThis.location = { origin: 'http://localhost:3220' } as Location
  globalThis.fetch = fakeFetch as typeof fetch
})

afterAll(() => {
  uninstallMemoryStorage('sessionStorage')
  globalThis.location = realLocation
  globalThis.fetch = realFetch
})

afterEach(() => {
  server.requests.length = 0
  focusManager.setFocused(undefined)
})

describe('sessionQuery', () => {
  test('reads the user or null from the page origin with the cookie, and refetches on focus', async () => {
    const { queryClient } = await setup(userA)
    expect(queryClient.getQueryData(sessionQuery.queryKey)).toEqual(userA)
    expect(server.requests[0]?.url).toBe('http://localhost:3220/api/auth/get-session')
    expect(server.requests[0]?.init?.credentials).toBe('same-origin')

    // An observer stands in for the page that keeps the session on screen.
    queryClient.mount()
    const observer = new QueryObserver(queryClient, sessionQuery)
    const stop = observer.subscribe(() => {})
    await until(() => !observer.getCurrentResult().isFetching)
    server.user = null
    focusManager.setFocused(true)
    await until(() => queryClient.getQueryData(sessionQuery.queryKey) === null)
    stop()
    queryClient.unmount()
  })
})

describe('watchIdentity', () => {
  test('switching users leaves nothing of the previous one in the cache or the pending link', async () => {
    const { queryClient, changes } = await setup(userA)
    await queryClient.fetchQuery({ queryKey: accountKey(userA.id, 'machines'), queryFn: () => ['A laptop'] })
    await queryClient.fetchQuery({
      queryKey: accountKey(userA.id, 'sessions'),
      queryFn: async () => (await authClient().listSessions()).data,
    })
    // A machines request still on its way when the user signs out, which ignores its abort signal.
    let answerLate: (names: string[]) => void = () => {}
    const late = queryClient
      .fetchQuery({
        queryKey: accountKey(userA.id, 'machines', 'page-2'),
        queryFn: () => new Promise<string[]>((resolve) => (answerLate = resolve)),
      })
      .catch(() => undefined)
    setPendingMachineLink({ machineId: 'm1', key: 'machine-key' })
    expect(cacheDump(queryClient)).toContain('token-user-a')

    await signOut(queryClient)
    answerLate(['A desktop'])
    await late
    expect(await signInWithEmail(queryClient, userB.email, 'pw')).toBeNull()
    const bMachines = await queryClient.fetchQuery({
      queryKey: accountKey(userB.id, 'machines'),
      queryFn: () => ['B laptop'],
    })

    const dump = cacheDump(queryClient)
    for (const secret of [userA.id, 'A laptop', 'A desktop', 'token-user-a']) expect(dump).not.toContain(secret)
    expect(bMachines).toEqual(['B laptop'])
    expect(queryClient.getQueryData(sessionQuery.queryKey)).toEqual(userB)
    expect(readPendingMachineLink()).toBeNull()
    expect(changes()).toBe(2)
  })

  test('an unauthorized answer rereads the session and clears the cache when it ended', async () => {
    const { queryClient, changes } = await setup(userA)
    setPendingMachineLink({ machineId: 'm1', key: 'machine-key' })
    // The session was revoked elsewhere, so the server now refuses it.
    server.user = null
    await queryClient.fetchQuery(accountQuery(userA.id, serverRoutes.account.me, {})).catch(() => {})

    await until(() => queryClient.getQueryData(sessionQuery.queryKey) === null)
    expect(
      queryClient
        .getQueryCache()
        .getAll()
        .map((q) => q.queryKey),
    ).toEqual([['session']])
    expect(readPendingMachineLink()).toBeNull()
    expect(changes()).toBe(1)
  })
})

describe('signInWithEmail', () => {
  test('an unverified address is told to open the link in its inbox, and stays signed out', async () => {
    const { queryClient } = await setup(null)
    expect(await signInWithEmail(queryClient, 'unverified@example.com', 'pw')).toBe(
      'Verify your email address first: open the link we sent to your inbox.',
    )
    expect(queryClient.getQueryData(sessionQuery.queryKey)).toBeNull()
  })
})

describe('signUpWithEmail', () => {
  test('posts the name, email and password and stays signed out, alike for a taken address', async () => {
    const { queryClient } = await setup(null)
    for (const email of ['new@example.com', userA.email]) {
      server.requests.length = 0
      expect(await signUpWithEmail(email, 'long enough', 'Ada')).toBeNull()
      const request = server.requests.find((r) => r.url.endsWith('/api/auth/sign-up/email'))
      expect(request?.init?.method).toBe('POST')
      expect(JSON.parse(String(request?.init?.body))).toMatchObject({ email, password: 'long enough', name: 'Ada' })
    }
    expect(await refetchSession(queryClient)).toBeNull()

    expect(await signUpWithEmail('busy@example.com', 'long enough', 'Ada')).toBe(
      'Too many attempts. Wait a minute and try again.',
    )
    expect(await signUpWithEmail('broken@example.com', 'long enough', 'Ada')).toBe(
      'Creating the account failed. Try again.',
    )
  })
})

describe('safeRedirect', () => {
  test('keeps same-origin paths and sends everything else home', () => {
    for (const safe of ['/m/x?tab=2#top', '/authors', '/m/auth']) expect(safeRedirect(safe)).toBe(safe)
    for (const unsafe of [
      'https://evil.example',
      '//evil.example',
      '/\\evil.example',
      '/\t/evil.example',
      'evil.example',
      undefined,
      '',
    ]) {
      expect(safeRedirect(unsafe)).toBe('/')
    }
  })

  test('never goes back to a page under /auth, however the path is spelled', () => {
    for (const auth of [
      '/auth',
      '/auth/',
      '/auth/sign-in?redirect=/m/x',
      '/AUTH/Sign-Up',
      '/./auth/sign-in',
      '/m/../auth/sign-up',
      '/%61uth/sign-in',
      '/%E0%A4%A',
    ]) {
      expect(safeRedirect(auth)).toBe('/')
    }
  })
})

// Type-level checks, enforced by `bun run typecheck`. They are never called.
export function typeChecks() {
  accountQuery('u', serverRoutes.account.me, {})
  // @ts-expect-error A public endpoint holds no account data.
  accountQuery('u', serverRoutes.system.health, {})
  // @ts-expect-error A signed-in endpoint must be keyed by its user.
  serverQuery(serverRoutes.account.me, {})
}
