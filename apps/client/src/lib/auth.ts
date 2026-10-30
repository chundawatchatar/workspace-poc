import type { ServerEndpointInput, ServerEndpointOutput, ServerErrorCode, ServerReadEndpoint } from '@orch/shared'
import { type Query, type QueryClient, queryOptions } from '@tanstack/react-query'
import { redirect } from '@tanstack/react-router'
import { createAuthClient } from 'better-auth/react'
import { clearPendingMachineLink } from './pendingLink'
import { callServer, ServerError } from './server'

// Who is signed in, and the rules that keep one account's data away from the next. The session lives in the query
// cache under `['session']`; everything an account owns lives under `accountKey(userId, …)`.

/** The signed-in user, as the client keeps them. The session token never enters the cache. */
export interface SessionUser {
  id: string
  email: string
  name: string
}

function createClient() {
  return createAuthClient({
    // The page's own origin, where the server mounts Better Auth under `/api/auth`. Passing it keeps Better Auth
    // from guessing the URL from environment variables.
    baseURL: location.origin,
    fetchOptions: {
      credentials: 'same-origin',
      // Look `fetch` up on every call rather than once, so a test can swap it.
      customFetchImpl: (input, init) => fetch(input, init),
    },
  })
}

let client: ReturnType<typeof createClient> | undefined

/**
 * The Better Auth client for `/api/auth/*` on the page's origin. It is made on first use, so the prerender, which
 * has no page origin, never makes one.
 */
export function authClient(): ReturnType<typeof createClient> {
  client ??= createClient()
  return client
}

/**
 * The session: the signed-in user, or null when signed out. A server without accounts (404) also reads as signed
 * out. It refetches when the window regains focus, which is how a sign-out in another tab is noticed.
 */
export const sessionQuery = queryOptions<SessionUser | null>({
  queryKey: ['session'],
  queryFn: async ({ signal }) => {
    const { data, error } = await authClient().getSession({ fetchOptions: { signal } })
    if (error) {
      if (error.status === 401 || error.status === 404) return null
      throw new Error(`Reading the session failed with ${error.status}.`)
    }
    if (!data?.user) return null
    const { id, email, name } = data.user
    return { id, email, name }
  },
  refetchOnWindowFocus: true,
})

/** Reads the session again now, even when the cached one is fresh. */
export function refetchSession(queryClient: QueryClient): Promise<SessionUser | null> {
  return queryClient.fetchQuery({ ...sessionQuery, staleTime: 0 })
}

/**
 * The query key for data that belongs to one account. Every query holding account data uses it, so an identity
 * change can drop all of it at once.
 */
export function accountKey<const Parts extends readonly unknown[]>(userId: string, ...parts: Parts) {
  return ['account', userId, ...parts] as const
}

/** Query options for a signed-in GET endpoint of `serverRoutes`, keyed under the user it belongs to. */
export function accountQuery<E extends ServerReadEndpoint & { auth: 'user' }>(
  userId: string,
  endpoint: E,
  input: ServerEndpointInput<E>,
) {
  return queryOptions<ServerEndpointOutput<E>, ServerError<ServerErrorCode<E>>>({
    queryKey: accountKey(userId, endpoint.path, input),
    queryFn: ({ signal }) => callServer(endpoint, input, signal),
  })
}

const TOO_MANY_ATTEMPTS = 'Too many attempts. Wait a minute and try again.'

/**
 * Signs in with an email and password, then reads the session, which hands the cache to the new user. Returns a
 * message to show, or null on success.
 */
export async function signInWithEmail(queryClient: QueryClient, email: string, password: string) {
  const { error } = await authClient().signIn.email({ email, password })
  if (error) {
    if (error.status === 401) return 'Wrong email or password.'
    if (error.status === 403) return 'Verify your email address first: open the link we sent to your inbox.'
    if (error.status === 429) return TOO_MANY_ATTEMPTS
    return 'Signing in failed. Try again.'
  }
  await refetchSession(queryClient)
  return null
}

/**
 * Creates an account and asks the server to email a verification link. It never signs in: the account can't be used
 * until the address is verified. An address that already has an account gets the same answer as a new one, so this
 * can't tell which it was. Returns a message to show, or null when the email is on its way.
 */
export async function signUpWithEmail(email: string, password: string, name: string) {
  const { error } = await authClient().signUp.email({ email, password, name })
  if (!error) return null
  if (error.status === 429) return TOO_MANY_ATTEMPTS
  return 'Creating the account failed. Try again.'
}

/** What a link page shows when the server refuses its token: expired, already used, malformed or for no account. */
export const EXPIRED_LINK = 'This link has expired or is no longer valid.'

/**
 * Asks the server to email a new verification link to `email`. The server answers the same whether the address has
 * an unverified account, a verified one or none, so this can't tell either. Returns a message to show, or null.
 */
export async function resendVerificationEmail(email: string) {
  const { error } = await authClient().sendVerificationEmail({ email })
  if (!error) return null
  if (error.status === 429) return TOO_MANY_ATTEMPTS
  return 'Sending the email failed. Try again.'
}

/**
 * Verifies an email address with the token from its emailed link. It never signs in. Returns a message to show,
 * `EXPIRED_LINK` for any refused token, or null once the address is verified.
 */
export async function verifyEmailToken(token: string) {
  const { error } = await authClient().verifyEmail({ query: { token } })
  if (!error) return null
  if (error.status === 400 || error.status === 401) return EXPIRED_LINK
  if (error.status === 429) return TOO_MANY_ATTEMPTS
  return 'Verifying the address failed. Try again.'
}

/**
 * Asks the server to email a password-reset link to `email`. The answer is the same whether or not the address has
 * an account. Returns a message to show, or null.
 */
export async function requestPasswordReset(email: string) {
  const { error } = await authClient().requestPasswordReset({ email })
  if (!error) return null
  if (error.status === 429) return TOO_MANY_ATTEMPTS
  return 'Sending the email failed. Try again.'
}

/**
 * Sets a new password with the token from a reset link, then reads the session again: the server ends every session
 * of the account, so one in this browser signs out and the cache is cleared. Returns a message to show,
 * `EXPIRED_LINK` for a refused token, or null once the password has changed.
 */
export async function resetPassword(queryClient: QueryClient, token: string, newPassword: string) {
  const { error } = await authClient().resetPassword({ token, newPassword })
  if (error) {
    if (error.code === 'INVALID_TOKEN') return EXPIRED_LINK
    if (error.status === 429) return TOO_MANY_ATTEMPTS
    return 'Changing the password failed. Try again.'
  }
  // The password has changed whatever this read finds; a failed read leaves the guards to notice later.
  await refetchSession(queryClient).catch(() => {})
  return null
}

/**
 * Signs out and marks the session as signed out, which clears every account's data from the cache. Throws when the
 * server still holds the session afterwards.
 */
export async function signOut(queryClient: QueryClient) {
  const { error } = await authClient().signOut()
  if (!error) {
    queryClient.setQueryData(sessionQuery.queryKey, null)
    return
  }
  // A session that already ended can't be signed out of; reading it settles who is signed in.
  if (await refetchSession(queryClient)) throw new Error('Signing out failed. Try again.')
}

function isSession(query: Query) {
  return query.queryKey.length === 1 && query.queryKey[0] === 'session'
}

function isUnauthorized(error: unknown) {
  return error instanceof ServerError && error.code === 'unauthorized'
}

/**
 * Watches the session in `queryClient` and, whenever the signed-in user changes (sign-in, sign-out, or another
 * account), drops everything but the session: in-flight queries are cancelled so a late answer for the old user
 * never lands, and cached queries and mutations are removed. Signing out or switching accounts also clears the
 * pending machine link; signing in from signed out keeps it, so the connect link that led to the sign-in is sent for
 * the new user. Then it calls `onChange`, which reruns the route guards. A query or mutation that fails as `unauthorized` reads the session
 * again, so a session revoked elsewhere goes the same way. Returns a function that stops watching.
 */
export function watchIdentity(queryClient: QueryClient, onChange: () => void) {
  const cached = queryClient.getQueryData(sessionQuery.queryKey)
  // Undefined until the session is first read: reading it for the first time is not a change.
  let userId = cached === undefined ? undefined : (cached?.id ?? null)

  const refresh = () => void refetchSession(queryClient).catch(() => {})

  const onSession = (user: SessionUser | null) => {
    const next = user?.id ?? null
    const previous = userId
    userId = next
    if (previous === undefined || previous === next) return
    const others = { predicate: (query: Query) => !isSession(query) }
    void queryClient.cancelQueries(others)
    queryClient.removeQueries(others)
    queryClient.getMutationCache().clear()
    // This runs before anything reacts to the new session, so a link left by one user is never sent for another.
    if (previous !== null) clearPendingMachineLink()
    onChange()
  }

  const stopQueries = queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated') return
    const { query, action } = event
    if (isSession(query)) {
      if (action.type === 'success') onSession(action.data as SessionUser | null)
    } else if (action.type === 'error' && isUnauthorized(action.error)) {
      refresh()
    }
  })
  const stopMutations = queryClient.getMutationCache().subscribe((event) => {
    if (event.type === 'updated' && event.action.type === 'error' && isUnauthorized(event.action.error)) refresh()
  })
  return () => {
    stopQueries()
    stopMutations()
  }
}

/**
 * A route's `beforeLoad` that sends a signed-out user to `/auth/sign-in`, with the page they asked for in `redirect`.
 * The prerendered shell has no session to read, so it lets the prerender through.
 */
export async function requireSession({
  context,
  location,
}: {
  context: { queryClient: QueryClient }
  location: { href: string }
}) {
  if (import.meta.env.SSR) return
  const user = await context.queryClient.ensureQueryData({ ...sessionQuery, revalidateIfStale: true })
  if (!user) throw redirect({ to: '/auth/sign-in', search: { redirect: location.href } })
}

/**
 * The `beforeLoad` of `/auth/sign-in` and `/auth/sign-up`: a signed-in user goes straight to `safeRedirect(redirect)`.
 * Neither page is ever guarded, or a signed-out user could never reach it. The `/auth` layout has none of its own, so
 * a page there that a signed-in user may need, such as one an emailed link opens, can leave it off.
 */
export async function leaveIfSignedIn({
  context,
  search,
}: {
  context: { queryClient: QueryClient }
  search: { redirect?: string }
}) {
  if (import.meta.env.SSR) return
  // A session that can't be read leaves the form up, where submitting it reports the problem.
  const user = await context.queryClient.ensureQueryData(sessionQuery).catch(() => null)
  if (user) throw redirect({ href: safeRedirect(search.redirect) })
}

/**
 * Where to go after signing in: `value` when it is a path on this origin, else `/`. Never a page under `/auth`, so
 * signing in can't loop back to a sign-in or into an emailed link's page.
 */
export function safeRedirect(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) {
    return '/'
  }
  // Browsers drop tabs and newlines from URLs, which could turn `/\t/host` into `//host`.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Matching control characters is the point.
  if (/[\u0000-\u001f\u007f\s]/.test(value)) return '/'
  const base = 'http://page.invalid'
  const url = new URL(value, base)
  if (url.origin !== base) return '/'
  // The router decodes the path and matches it case-insensitively, and a trailing slash still reaches the same route.
  let path: string
  try {
    path = decodeURIComponent(url.pathname)
  } catch {
    return '/'
  }
  path = path.toLowerCase().replace(/\/+$/, '')
  if (path === '/auth' || path.startsWith('/auth/')) return '/'
  return value
}
