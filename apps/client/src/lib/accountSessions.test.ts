import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { FormApi } from '@tanstack/react-form'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
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

interface FakeSession {
  id: string
  token: string
  userAgent: string | null
  ipAddress: string | null
  createdAt: string
  updatedAt: string
}

/** The fake server: the account's sessions, which one the cookie holds, how it answers, and every request. */
const server = {
  sessions: [] as FakeSession[],
  currentId: null as string | null,
  listAnswer: 200 as 200 | 401 | 403 | 500,
  failRevoke: false,
  requests: [] as { path: string; body: unknown }[],
}

function session(id: string, userAgent: string | null, ipAddress: string | null): FakeSession {
  return {
    id,
    token: `secret-token-${id}`,
    userAgent,
    ipAddress,
    createdAt: '2026-10-29T08:00:00.000Z',
    updatedAt: '2026-10-30T09:30:00.000Z',
  }
}

const realFetch = globalThis.fetch
const realLocation = globalThis.location

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit) {
  const url = new URL(String(input instanceof Request ? input.url : input), location.origin)
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
  server.requests.push({ path: url.pathname, body })
  const current = server.sessions.find((s) => s.id === server.currentId)
  const unauthorized = () => Response.json({ code: 'UNAUTHORIZED' }, { status: 401 })
  if (url.pathname === '/api/auth/get-session') {
    return Response.json(current ? { user: { ...user, emailVerified: true }, session: current } : null)
  }
  if (!current) return unauthorized()
  switch (url.pathname) {
    case '/api/auth/list-sessions':
      if (server.listAnswer === 403) return Response.json({ code: 'SESSION_NOT_FRESH' }, { status: 403 })
      if (server.listAnswer !== 200) return Response.json({ code: 'X' }, { status: server.listAnswer })
      return Response.json(server.sessions)
    case '/api/auth/revoke-session':
      if (server.failRevoke) return Response.json({ code: 'INTERNAL' }, { status: 500 })
      server.sessions = server.sessions.filter((s) => s.token !== body.token)
      return Response.json({ status: true })
    case '/api/auth/revoke-sessions':
      server.sessions = []
      return Response.json({ status: true })
    case '/api/auth/change-password': {
      if (body.currentPassword !== 'old password') {
        return Response.json({ code: 'INVALID_PASSWORD', message: 'Invalid password' }, { status: 400 })
      }
      // Like Better Auth 1.7.14: every session ends and a new one starts for this browser.
      const fresh = session('s-new', current.userAgent, current.ipAddress)
      server.sessions = [fresh]
      server.currentId = fresh.id
      return Response.json({ token: fresh.token, user })
    }
  }
  return Response.json({ code: 'NOT_FOUND' }, { status: 404 })
}

/** A query client with the identity watcher, signed in on `s-1` with another session on `s-2`. */
async function setup() {
  server.sessions = [session('s-1', firefoxMac, '203.0.113.7'), session('s-2', chromeWindows, null)]
  server.currentId = 's-1'
  server.listAnswer = 200
  server.failRevoke = false
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  watchIdentity(queryClient, () => {})
  await refetchSession(queryClient)
  server.requests.length = 0
  return queryClient
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

const sentTo = (path: string) => server.requests.filter((r) => r.path === path)

/** Resolves once `check` holds, or fails after a second. */
async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(10)
  expect(check()).toBe(true)
}

beforeAll(() => {
  globalThis.location = { origin: 'http://localhost:3220' } as Location
  globalThis.fetch = fakeFetch as typeof fetch
})

afterAll(() => {
  globalThis.location = realLocation
  globalThis.fetch = realFetch
})

beforeEach(() => {
  server.requests.length = 0
})

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
    const queryClient = await setup()
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
    expect(cacheDump(queryClient)).not.toContain('secret-token')
  })

  test('a stale session fails as not fresh, and a revoked one rereads the session, which ends it', async () => {
    const queryClient = await setup()
    server.listAnswer = 403
    const stale = await queryClient.fetchQuery(sessionsQuery(user.id)).catch((error) => error)
    expect(isNotFresh(stale)).toBe(true)

    // The session was revoked on another device.
    server.currentId = null
    const ended = await queryClient.fetchQuery(sessionsQuery(user.id)).catch((error) => error)
    expect(isNotFresh(ended)).toBe(false)
    await until(() => queryClient.getQueryData(sessionQuery.queryKey) === null)
    expect(queryClient.getQueryData(accountKey(user.id, 'sessions'))).toBeUndefined()
  })
})

describe('revokeSession', () => {
  test('sends the token looked up by id and drops the row; a refusal leaves the list as it was', async () => {
    const queryClient = await setup()
    const stop = watchList(queryClient)
    await until(() => queryClient.getQueryData(sessionsQuery(user.id).queryKey)?.length === 2)

    server.failRevoke = true
    await expect(revokeSession(queryClient, user.id, 's-2')).rejects.toThrow()
    expect(queryClient.getQueryData(sessionsQuery(user.id).queryKey)?.map((r) => r.id)).toEqual(['s-1', 's-2'])

    server.failRevoke = false
    await revokeSession(queryClient, user.id, 's-2')
    expect(sentTo('/api/auth/revoke-session').map((r) => r.body)).toEqual([
      { token: 'secret-token-s-2' },
      { token: 'secret-token-s-2' },
    ])
    expect(queryClient.getQueryData(sessionsQuery(user.id).queryKey)?.map((r) => r.id)).toEqual(['s-1'])
    expect(cacheDump(queryClient)).not.toContain('secret-token')
    stop()
  })
})

describe('signOutEverywhere', () => {
  test('ends every session and signs out here, which clears the account data', async () => {
    const queryClient = await setup()
    await queryClient.fetchQuery(sessionsQuery(user.id))
    await signOutEverywhere(queryClient)
    expect(sentTo('/api/auth/revoke-sessions')).toHaveLength(1)
    expect(queryClient.getQueryData(sessionQuery.queryKey)).toBeNull()
    expect(queryClient.getQueryData(sessionsQuery(user.id).queryKey)).toBeUndefined()
  })
})

describe('changing the password', () => {
  /** Submits `form` and resolves once the submit is done. */
  async function submit(form: { handleSubmit: () => Promise<unknown>; state: { isSubmitting: boolean } }) {
    await form.handleSubmit()
    for (let i = 0; i < 100 && form.state.isSubmitting; i++) await Bun.sleep(10)
  }

  test('an invalid form sends nothing; a valid one ends other sessions, keeps this one and drops the token', async () => {
    const queryClient = await setup()
    const stop = watchList(queryClient)
    await until(() => queryClient.getQueryData(sessionsQuery(user.id).queryKey)?.length === 2)
    let problem: string | null = null
    let changed = 0
    const form = new FormApi(
      changePasswordFormOptions(queryClient, { setProblem: (m) => (problem = m), onChanged: () => changed++ }),
    )
    form.mount()
    form.setFieldValue('currentPassword', 'old password')
    form.setFieldValue('newPassword', 'a brand new passphrase')
    form.setFieldValue('confirmPassword', 'a brand new typo')
    await submit(form)
    expect(sentTo('/api/auth/change-password')).toHaveLength(0)

    form.setFieldValue('confirmPassword', 'a brand new passphrase')
    await submit(form)
    expect(sentTo('/api/auth/change-password').map((r) => r.body)).toEqual([
      { currentPassword: 'old password', newPassword: 'a brand new passphrase', revokeOtherSessions: true },
    ])
    expect(problem as string | null).toBeNull()
    expect(changed).toBe(1)
    expect(form.state.values).toEqual({ currentPassword: '', newPassword: '', confirmPassword: '' })
    await until(() => queryClient.getQueryData(sessionsQuery(user.id).queryKey)?.[0]?.id === 's-new')
    expect(queryClient.getQueryData(sessionsQuery(user.id).queryKey)).toEqual([
      expect.objectContaining({ id: 's-new', current: true }),
    ])
    expect(queryClient.getQueryData(sessionQuery.queryKey)).toEqual(user)
    expect(cacheDump(queryClient)).not.toContain('secret-token')
    stop()
  })

  test('a wrong current password says so', async () => {
    const queryClient = await setup()
    expect(await changePassword(queryClient, 'not it', 'a brand new passphrase')).toBe(
      'Your current password is wrong.',
    )
  })
})
