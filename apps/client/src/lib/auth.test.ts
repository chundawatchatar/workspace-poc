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
  resetPassword,
  type SessionUser,
  SIGN_UP_CODE_REFUSED,
  safeRedirect,
  sendSignUpCode,
  sessionQuery,
  signInWithEmail,
  signOut,
  signUpWithCode,
  watchIdentity,
} from './auth'
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

  test('a 401 reads as signed out, and any other status, a 404 included, fails', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    server.use(http.get('*/api/auth/get-session', () => authError(401, 'UNAUTHORIZED', 'Unauthorized')))
    expect(await refetchSession(queryClient)).toBeNull()
    server.use(
      http.get('*/api/auth/get-session', () =>
        HttpResponse.json({ error: { code: 'not_found', message: 'Not found.' } }, { status: 404 }),
      ),
    )
    await expect(refetchSession(queryClient)).rejects.toThrow('Reading the session failed with 404.')
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
  test('switching users leaves nothing of the previous one in the cache', async () => {
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
    expect(changes()).toBe(2)
  })

  test('an unauthorized answer rereads the session and clears the cache when it ended', async () => {
    const { queryClient, account, changes } = await setup(userA)
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
    expect(changes()).toBe(1)
  })
})

describe('signInWithEmail', () => {
  test('a 403 gets the generic failure, with no mention of a verification link, and stays signed out', async () => {
    const { queryClient } = await setup(null)
    expect(await signInWithEmail(queryClient, 'unverified@example.com', 'pw')).toBe('Signing in failed. Try again.')
    expect(queryClient.getQueryData(sessionQuery.queryKey)).toBeNull()
  })
})

describe('sign-up by email code', () => {
  test('asking for a code posts only the address with type sign-in, and reports a rate limit', async () => {
    const requests: Request[] = []
    server.use(
      http.post('*/api/auth/email-otp/send-verification-otp', async ({ request }) => {
        requests.push(request.clone())
        const { email } = (await request.json()) as { email: string }
        if (email === 'busy@example.com') return rateLimited()
        if (email === 'broken@example.com') return authError(500, 'INTERNAL_SERVER_ERROR', 'Internal Server Error')
        // Like the cloud server: the same answer whether or not the address has an account.
        return HttpResponse.json({ success: true })
      }),
    )
    expect(await sendSignUpCode('new@example.com')).toBeNull()
    expect(await sent(requests[0] as Request)).toEqual({
      method: 'POST',
      search: '',
      body: { email: 'new@example.com', type: 'sign-in' },
    })
    expect(await sendSignUpCode('busy@example.com')).toBe('Too many attempts. Wait a minute and try again.')
    expect(await sendSignUpCode('broken@example.com')).toBe('Sending the code failed. Try again.')
  })

  test('the code creates the account and reads the session; each refusal gets its own message', async () => {
    const { queryClient, account, changes } = await setup(null)
    const requests: Request[] = []
    server.use(
      http.post('*/api/auth/sign-up/email-code', async ({ request }) => {
        requests.push(request.clone())
        const { code } = (await request.json()) as { code: string }
        if (code === '111111') return authError(400, 'INVALID_OR_EXPIRED_CODE', 'Invalid or expired code')
        if (code === '222222') return rateLimited()
        if (code === '333333') return authError(400, 'PASSWORD_TOO_SHORT', 'Password too short')
        if (code === '444444') return authError(500, 'INTERNAL_SERVER_ERROR', 'Internal Server Error')
        account.user = userA
        return HttpResponse.json({ token: 't1', user: authUser(userA) })
      }),
    )
    const details = { name: userA.name, email: userA.email, password: 'long enough' }
    expect(await signUpWithCode(queryClient, { ...details, code: '111111' })).toBe(SIGN_UP_CODE_REFUSED)
    expect(await signUpWithCode(queryClient, { ...details, code: '222222' })).toBe(
      'Too many attempts. Wait a minute and try again.',
    )
    for (const code of ['333333', '444444']) {
      expect(await signUpWithCode(queryClient, { ...details, code })).toBe('Creating the account failed. Try again.')
    }
    expect(changes()).toBe(0)

    expect(await signUpWithCode(queryClient, { ...details, code: '123456' })).toBeNull()
    expect(await sent(requests.at(-1) as Request)).toEqual({
      method: 'POST',
      search: '',
      body: { ...details, code: '123456' },
    })
    expect(queryClient.getQueryData(sessionQuery.queryKey)).toEqual(userA)
    expect(changes()).toBe(1)
  })
})

describe('the email link functions', () => {
  test('forgot password posts the address, answers alike for any account, and reports a rate limit', async () => {
    const requests: Request[] = []
    server.use(
      http.post('*/api/auth/request-password-reset', async ({ request }) => {
        requests.push(request.clone())
        // Like the cloud server: the same answer whether or not the address has an account.
        const { email } = (await request.json()) as { email: string }
        if (email === 'busy@example.com') return rateLimited()
        return HttpResponse.json({ status: true })
      }),
    )
    expect(await requestPasswordReset('new@example.com')).toBeNull()
    expect(await requestPasswordReset(userA.email)).toBeNull()
    expect(await Promise.all(requests.map(sent))).toEqual([
      { method: 'POST', search: '', body: { email: 'new@example.com' } },
      { method: 'POST', search: '', body: { email: userA.email } },
    ])
    expect(await requestPasswordReset('busy@example.com')).toBe('Too many attempts. Wait a minute and try again.')
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
