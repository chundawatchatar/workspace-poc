import { describe, expect, test } from 'bun:test'
import { FormApi } from '@tanstack/react-form'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { waitFor } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { authError, authSession, authUser } from '../test/betterAuth'
import { server } from '../test/msw'
import {
  changePassword,
  describeDevice,
  isNotFresh,
  revokeSession,
  sessionsQuery,
  signOutEverywhere,
} from './accountSessions'
import { accountKey, refetchSession, type SessionUser, sessionQuery, watchIdentity } from './auth'
import { changePasswordFormOptions } from './authForms'

const user: SessionUser = { id: 'user-a', email: 'a@example.com', name: 'Ada' }

const firefoxMac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:131.0) Gecko/20100101 Firefox/131.0'
const chromeWindows =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

type FakeSession = ReturnType<typeof authSession>

function session(id: string, userAgent: string | null, ipAddress: string | null): FakeSession {
  return authSession(id, user.id, { userAgent, ipAddress, createdAt: '2026-10-29T08:00:00.000Z' })
}

/**
 * Answers Better Auth's session endpoints like the cloud server for the account's `sessions`, the cookie holding
 * `currentId`, and records the JSON body of each request by path. Signed in on `s-1`, with another session on `s-2`.
 */
function fakeSessions() {
  const state = {
    sessions: [session('s-1', firefoxMac, '203.0.113.7'), session('s-2', chromeWindows, null)],
    currentId: 's-1' as string | null,
    bodies: {} as Record<string, unknown[]>,
  }
  const current = () => state.sessions.find((s) => s.id === state.currentId)
  const unauthorized = () => authError(401, 'UNAUTHORIZED', 'Unauthorized')
  /** Records the body sent to `path`, and answers 401 when the cookie holds no session. */
  const signedIn = (path: string, answer: (body: Record<string, unknown>) => Response | Promise<Response>) =>
    http.post(`*${path}`, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>
      state.bodies[path] = [...(state.bodies[path] ?? []), body]
      return current() ? answer(body) : unauthorized()
    })
  server.use(
    http.get('*/api/auth/get-session', () => {
      const mine = current()
      return HttpResponse.json(mine ? { user: authUser(user), session: mine } : null)
    }),
    http.get('*/api/auth/list-sessions', () => (current() ? HttpResponse.json(state.sessions) : unauthorized())),
    signedIn('/api/auth/revoke-session', (body) => {
      state.sessions = state.sessions.filter((s) => s.token !== body.token)
      return HttpResponse.json({ status: true })
    }),
    signedIn('/api/auth/revoke-sessions', () => {
      state.sessions = []
      return HttpResponse.json({ status: true })
    }),
    signedIn('/api/auth/change-password', (body) => {
      if (body.currentPassword !== 'pw-old') return authError(400, 'INVALID_PASSWORD', 'Invalid password')
      // Like Better Auth 1.7.14: every session ends and a new one starts for this browser.
      const mine = current() as FakeSession
      const fresh = session('s-new', mine.userAgent, mine.ipAddress)
      state.sessions = [fresh]
      state.currentId = fresh.id
      return HttpResponse.json({ token: fresh.token, user: authUser(user) })
    }),
  )
  return state
}

/** A query client with the identity watcher, signed in against `fakeSessions()`. */
async function setup() {
  const state = fakeSessions()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  watchIdentity(queryClient, () => {})
  await refetchSession(queryClient)
  return { queryClient, state }
}

/** Keeps the list on screen, as the account page does, so invalidating it reads it again. */
function watchList(queryClient: QueryClient) {
  return new QueryObserver(queryClient, sessionsQuery(user.id)).subscribe(() => {})
}

/** Everything the query and mutation caches hold, as one string to search. */
function cacheDump(queryClient: QueryClient) {
  return JSON.stringify([
    queryClient
      .getQueryCache()
      .getAll()
      .map((q) => [q.queryKey, q.state.data]),
    queryClient
      .getMutationCache()
      .getAll()
      .map((m) => [m.state.data, m.state.variables]),
  ])
}

describe('describeDevice', () => {
  test.each([
    [firefoxMac, 'Firefox on macOS'],
    [chromeWindows, 'Chrome on Windows'],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
      'Safari on macOS',
    ],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0', 'Firefox on Linux'],
    [
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      'Chrome on Linux',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
      'Safari on iOS',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1',
      'Chrome on iOS',
    ],
    [
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
      'Chrome on Android',
    ],
    ['Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0', 'Firefox on Android'],
    ['', 'Unknown device'],
    [null, 'Unknown device'],
    ['curl/8.7.1', 'Unknown device'],
  ])('%p reads as %p', (agent, expected) => {
    expect(describeDevice(agent)).toBe(expected)
  })
})

describe('sessionsQuery', () => {
  test('lists every session under the account key, marks this one, and keeps no token in the cache', async () => {
    const { queryClient } = await setup()
    const query = sessionsQuery(user.id)
    expect(query.queryKey.slice(0, 2)).toEqual(['account', user.id])
    const rows = await queryClient.fetchQuery(query)

    expect(rows).toEqual([
      {
        id: 's-1',
        device: 'Firefox on macOS',
        ipAddress: '203.0.113.7',
        createdAt: '2026-10-29T08:00:00.000Z',
        lastActiveAt: '2026-10-30T09:30:00.000Z',
        current: true,
      },
      expect.objectContaining({ id: 's-2', device: 'Chrome on Windows', ipAddress: null, current: false }),
    ])
    expect(cacheDump(queryClient)).not.toContain('token-')
  })

  test('a stale session fails as not fresh, and a revoked one rereads the session, which ends it', async () => {
    const { queryClient, state } = await setup()
    server.use(
      http.get('*/api/auth/list-sessions', () => authError(403, 'SESSION_NOT_FRESH', 'Session is not fresh'), {
        once: true,
      }),
    )
    const stale = await queryClient.fetchQuery(sessionsQuery(user.id)).catch((error) => error)
    expect(isNotFresh(stale)).toBe(true)

    // The session was revoked on another device.
    state.currentId = null
    const ended = await queryClient.fetchQuery(sessionsQuery(user.id)).catch((error) => error)
    expect(isNotFresh(ended)).toBe(false)
    await waitFor(() => expect(queryClient.getQueryData(sessionQuery.queryKey)).toBeNull())
    expect(queryClient.getQueryData(accountKey(user.id, 'sessions'))).toBeUndefined()
  })
})

describe('revokeSession', () => {
  test('sends the token looked up by id and drops the row; a refusal leaves the list as it was', async () => {
    const { queryClient, state } = await setup()
    const stop = watchList(queryClient)
    await waitFor(() => expect(queryClient.getQueryData(sessionsQuery(user.id).queryKey)).toHaveLength(2))

    server.use(
      http.post('*/api/auth/revoke-session', () => authError(500, 'INTERNAL_SERVER_ERROR', 'Internal Server Error'), {
        once: true,
      }),
    )
    await expect(revokeSession(queryClient, user.id, 's-2')).rejects.toThrow()
    expect(queryClient.getQueryData(sessionsQuery(user.id).queryKey)?.map((r) => r.id)).toEqual(['s-1', 's-2'])

    // The token changed since the list was read, so only one looked up at revoke time ends the session.
    const s2 = state.sessions[1] as FakeSession
    s2.token = 'token-s-2-renewed'
    await revokeSession(queryClient, user.id, 's-2')
    expect(state.bodies['/api/auth/revoke-session']).toEqual([{ token: 'token-s-2-renewed' }])
    expect(queryClient.getQueryData(sessionsQuery(user.id).queryKey)?.map((r) => r.id)).toEqual(['s-1'])
    expect(cacheDump(queryClient)).not.toContain('token-')
    stop()
  })
})

describe('signOutEverywhere', () => {
  test('ends every session and signs out here, which clears the account data', async () => {
    const { queryClient, state } = await setup()
    await queryClient.fetchQuery(sessionsQuery(user.id))
    await signOutEverywhere(queryClient)
    expect(state.bodies['/api/auth/revoke-sessions']).toHaveLength(1)
    expect(queryClient.getQueryData(sessionQuery.queryKey)).toBeNull()
    expect(queryClient.getQueryData(sessionsQuery(user.id).queryKey)).toBeUndefined()
  })
})

describe('changing the password', () => {
  /** Submits `form` and resolves once the submit is done. */
  async function submit(form: { handleSubmit: () => Promise<unknown>; state: { isSubmitting: boolean } }) {
    await form.handleSubmit()
    await waitFor(() => expect(form.state.isSubmitting).toBe(false))
  }

  test('an invalid form sends nothing; a valid one ends other sessions, keeps this one and drops the token', async () => {
    const { queryClient, state } = await setup()
    const stop = watchList(queryClient)
    await waitFor(() => expect(queryClient.getQueryData(sessionsQuery(user.id).queryKey)).toHaveLength(2))
    let problem: string | null = null
    let changed = 0
    const form = new FormApi(
      changePasswordFormOptions(queryClient, { setProblem: (m) => (problem = m), onChanged: () => changed++ }),
    )
    form.mount()
    form.setFieldValue('currentPassword', 'pw-old')
    form.setFieldValue('newPassword', 'a brand new passphrase')
    form.setFieldValue('confirmPassword', 'a brand new typo')
    await submit(form)
    expect(state.bodies['/api/auth/change-password']).toBeUndefined()

    form.setFieldValue('confirmPassword', 'a brand new passphrase')
    await submit(form)
    expect(state.bodies['/api/auth/change-password']).toEqual([
      { currentPassword: 'pw-old', newPassword: 'a brand new passphrase', revokeOtherSessions: true },
    ])
    expect(problem as string | null).toBeNull()
    expect(changed).toBe(1)
    expect(form.state.values).toEqual({ currentPassword: '', newPassword: '', confirmPassword: '' })
    await waitFor(() => expect(queryClient.getQueryData(sessionsQuery(user.id).queryKey)?.[0]?.id).toBe('s-new'))
    expect(queryClient.getQueryData(sessionsQuery(user.id).queryKey)).toEqual([
      expect.objectContaining({ id: 's-new', current: true }),
    ])
    expect(queryClient.getQueryData(sessionQuery.queryKey)).toEqual(user)
    expect(cacheDump(queryClient)).not.toContain('token-')
    stop()
  })

  test('a wrong current password says so', async () => {
    const { queryClient } = await setup()
    expect(await changePassword(queryClient, 'not it', 'a brand new passphrase')).toBe(
      'Your current password is wrong.',
    )
  })
})
