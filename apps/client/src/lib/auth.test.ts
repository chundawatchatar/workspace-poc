import { afterEach, describe, expect, test } from 'bun:test'
import { serverRoutes } from '@orch/shared'
import { focusManager, QueryClient, QueryObserver } from '@tanstack/react-query'
import { waitFor } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { authError, authSession, authUser, rateLimited } from '../test/betterAuth'
import { server } from '../test/msw'
import {
  accountKey,
  accountQuery,
  authClient,
  EXPIRED_LINK,
  refetchSession,
  requestPasswordReset,
  requireSession,
  resendVerificationEmail,
  resetPassword,
  type SessionUser,
  safeRedirect,
  sessionQuery,
  signInWithEmail,
  signOut,
  signUpWithEmail,
  verifyEmailToken,
  watchIdentity,
} from './auth'
import { readPendingMachineLink, setPendingMachineLink } from './pendingLink'
import { serverQuery } from './server'

const userA: SessionUser = { id: 'user-a', email: 'a@example.com', name: 'Ada' }
const userB: SessionUser = { id: 'user-b', email: 'b@example.com', name: 'Bob' }

/**
 * Answers Better Auth's session, sign-in and sign-out endpoints the way the cloud server does for whoever the cookie
 * belongs to, which is `account.user`. It records every `get-session` request.
 */
function fakeAccount(user: SessionUser | null) {
  const account = { user, sessionReads: [] as Request[] }
  server.use(
    http.get('*/api/auth/get-session', ({ request }) => {
      account.sessionReads.push(request)
      const current = account.user
      return HttpResponse.json(
        current && { user: authUser(current), session: authSession(`s-${current.id}`, current.id) },
      )
    }),
    http.post('*/api/auth/sign-in/email', async ({ request }) => {
      const { email } = (await request.json()) as { email: string }
      if (email === 'unverified@example.com') return authError(403, 'EMAIL_NOT_VERIFIED', 'Email not verified')
      account.user = [userA, userB].find((u) => u.email === email) ?? null
      if (!account.user) return authError(401, 'INVALID_EMAIL_OR_PASSWORD', 'Invalid email or password')
      return HttpResponse.json({ redirect: false, token: 't1', user: authUser(account.user) })
    }),
    http.post('*/api/auth/sign-out', () => {
      account.user = null
      return HttpResponse.json({ success: true })
    }),
  )
  return account
}

/** A query client with the identity watcher, signed in as `user`. */
async function setup(user: SessionUser | null) {
  const account = fakeAccount(user)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  let changes = 0
  watchIdentity(queryClient, () => changes++)
  await refetchSession(queryClient)
  return { queryClient, account, changes: () => changes }
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

/** A request as method, query and JSON body, to compare in one `expect`. */
async function sent(request: Request) {
  const text = await request.text()
  return { method: request.method, search: new URL(request.url).search, body: text ? JSON.parse(text) : null }
}

afterEach(() => {
  focusManager.setFocused(undefined)
})

describe('sessionQuery', () => {
  test('reads the user or null from the page origin with the cookie, and refetches on focus', async () => {
    const { queryClient, account } = await setup(userA)
    expect(queryClient.getQueryData(sessionQuery.queryKey)).toEqual(userA)
    expect(account.sessionReads[0]?.url).toBe('http://localhost:3220/api/auth/get-session')
    expect(account.sessionReads[0]?.credentials).toBe('same-origin')

    // An observer stands in for the page that keeps the session on screen.
    queryClient.mount()
    const observer = new QueryObserver(queryClient, sessionQuery)
    const stop = observer.subscribe(() => {})
    await waitFor(() => expect(observer.getCurrentResult().isFetching).toBe(false))
    account.user = null
    focusManager.setFocused(true)
    await waitFor(() => expect(queryClient.getQueryData(sessionQuery.queryKey)).toBeNull())
    stop()
    queryClient.unmount()
  })

  test('a guard waiting on the first read still gets the session when the page watching it unmounts', async () => {
    fakeAccount(userA)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    // On a cold load the page starts the read, the guard waits on it, and the page unmounts while it is in flight.
    const stop = new QueryObserver(queryClient, sessionQuery).subscribe(() => {})
    const guard = requireSession({ context: { queryClient }, location: { href: '/settings/security' } })
    stop()
    await guard
    expect(queryClient.getQueryData(sessionQuery.queryKey)).toEqual(userA)
  })
})

describe('watchIdentity', () => {
  test('switching users leaves nothing of the previous one in the cache or the pending link', async () => {
    const { queryClient, changes } = await setup(userA)
    server.use(http.get('*/api/auth/list-sessions', () => HttpResponse.json([authSession('s-a', userA.id)])))
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
    setPendingMachineLink({ machineId: 'm1', name: 'Machine m1' })
    expect(cacheDump(queryClient)).toContain('token-s-a')

    await signOut(queryClient)
    answerLate(['A desktop'])
    await late
    expect(await signInWithEmail(queryClient, userB.email, 'pw')).toBeNull()
    const bMachines = await queryClient.fetchQuery({
      queryKey: accountKey(userB.id, 'machines'),
      queryFn: () => ['B laptop'],
    })

    const dump = cacheDump(queryClient)
    for (const secret of [userA.id, 'A laptop', 'A desktop', 'token-s-a']) expect(dump).not.toContain(secret)
    expect(bMachines).toEqual(['B laptop'])
    expect(queryClient.getQueryData(sessionQuery.queryKey)).toEqual(userB)
    expect(readPendingMachineLink()).toBeNull()
    expect(changes()).toBe(2)
  })

  test('signing in from signed out keeps the pending link for the new user', async () => {
    const { queryClient, changes } = await setup(null)
    setPendingMachineLink({ machineId: 'm1', name: 'Machine m1' })
    expect(await signInWithEmail(queryClient, userA.email, 'pw')).toBeNull()
    expect(readPendingMachineLink()).toMatchObject({ machineId: 'm1', name: 'Machine m1' })
    expect(changes()).toBe(1)
  })

  test('an unauthorized answer rereads the session and clears the cache when it ended', async () => {
    const { queryClient, account, changes } = await setup(userA)
    setPendingMachineLink({ machineId: 'm1', name: 'Machine m1' })
    // The session was revoked elsewhere, so the server now refuses it.
    account.user = null
    server.use(
      http.get(`*${serverRoutes.account.me.path}`, () =>
        HttpResponse.json({ error: { code: 'unauthorized', message: 'Sign in first.' } }, { status: 401 }),
      ),
    )
    await queryClient.fetchQuery(accountQuery(userA.id, serverRoutes.account.me, {})).catch(() => {})

    await waitFor(() => expect(queryClient.getQueryData(sessionQuery.queryKey)).toBeNull())
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
    const signUps: Request[] = []
    server.use(
      http.post('*/api/auth/sign-up/email', async ({ request }) => {
        signUps.push(request.clone())
        // Like the cloud server: a new and a taken address get the same answer, and no session either way.
        const { email, name } = (await request.json()) as { email: string; name: string }
        if (email === 'busy@example.com') return rateLimited()
        if (email === 'broken@example.com') return authError(500, 'INTERNAL_SERVER_ERROR', 'Internal Server Error')
        return HttpResponse.json({ token: null, user: authUser({ id: 'u1', email, name }) })
      }),
    )
    for (const email of ['new@example.com', userA.email]) {
      expect(await signUpWithEmail(email, 'long enough', 'Ada')).toBeNull()
      const request = signUps.at(-1)
      expect(request?.method).toBe('POST')
      expect(await request?.json()).toMatchObject({ email, password: 'long enough', name: 'Ada' })
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

describe('the email link functions', () => {
  test('resend and forgot password post the address, answer alike for any account, and report a rate limit', async () => {
    for (const [send, path] of [
      [resendVerificationEmail, '/api/auth/send-verification-email'],
      [requestPasswordReset, '/api/auth/request-password-reset'],
    ] as const) {
      const requests: Request[] = []
      server.use(
        http.post(`*${path}`, async ({ request }) => {
          requests.push(request.clone())
          // Like the cloud server: the same answer whether or not the address has an account.
          const { email } = (await request.json()) as { email: string }
          if (email === 'busy@example.com') return rateLimited()
          return HttpResponse.json({ status: true })
        }),
      )
      expect(await send('new@example.com')).toBeNull()
      expect(await send(userA.email)).toBeNull()
      expect(await Promise.all(requests.map(sent))).toEqual([
        { method: 'POST', search: '', body: { email: 'new@example.com' } },
        { method: 'POST', search: '', body: { email: userA.email } },
      ])
      expect(await send('busy@example.com')).toBe('Too many attempts. Wait a minute and try again.')
    }
  })

  test('verifying sends the token once in the query and reports any refusal as an expired link', async () => {
    const requests: Request[] = []
    server.use(
      http.get('*/api/auth/verify-email', ({ request }) => {
        requests.push(request)
        if (new URL(request.url).searchParams.get('token') === 'good')
          return HttpResponse.json({ status: true, user: null })
        return authError(401, 'TOKEN_EXPIRED', 'Token expired')
      }),
    )
    expect(await verifyEmailToken('good')).toBeNull()
    expect(await Promise.all(requests.map(sent))).toEqual([{ method: 'GET', search: '?token=good', body: null }])
    expect(await verifyEmailToken('old')).toBe(EXPIRED_LINK)
  })

  test('a reset posts the token and password, then rereads the session, which the reset ended', async () => {
    const { queryClient, account, changes } = await setup(userA)
    const requests: Request[] = []
    server.use(
      http.post('*/api/auth/reset-password', async ({ request }) => {
        requests.push(request.clone())
        const { token } = (await request.json()) as { token: string }
        if (token !== 'good') return authError(400, 'INVALID_TOKEN', 'Invalid token')
        // A reset ends every session of the account.
        account.user = null
        return HttpResponse.json({ status: true })
      }),
    )
    expect(await resetPassword(queryClient, 'stale', 'a brand new passphrase')).toBe(EXPIRED_LINK)
    expect(queryClient.getQueryData(sessionQuery.queryKey)).toEqual(userA)

    expect(await resetPassword(queryClient, 'good', 'a brand new passphrase')).toBeNull()
    expect(await sent(requests[1] as Request)).toEqual({
      method: 'POST',
      search: '',
      body: { token: 'good', newPassword: 'a brand new passphrase' },
    })
    expect(queryClient.getQueryData(sessionQuery.queryKey)).toBeNull()
    expect(changes()).toBe(1)
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
