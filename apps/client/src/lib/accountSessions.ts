import { type QueryClient, queryOptions } from '@tanstack/react-query'
import { accountKey, authClient, refetchSession, sessionQuery, TOO_MANY_ATTEMPTS } from './auth'

// Where the signed-in user is signed in, through Better Auth's own session endpoints. `list-sessions` answers every
// session's secret token; the rows here drop it, and a revoke looks it up again, so no token enters the query cache.

/** One of the account's sessions, as the account page shows it. It holds no token. */
export interface SessionRow {
  id: string
  /** The browser and system, read from the user agent, such as "Firefox on macOS". */
  device: string
  /** The address the session was created from, as the server saw it; null when unknown. */
  ipAddress: string | null
  /** ISO date and time. */
  createdAt: string
  /** ISO date and time of Better Auth's last refresh of the session, which happens at most once a day. */
  lastActiveAt: string
  /** True for the session this browser is using. */
  current: boolean
}

/** A refused or failed call to Better Auth, with its HTTP status and Better Auth's error code. */
export class AuthCallError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(`The request failed with ${status}${code ? ` (${code})` : ''}.`)
    this.name = 'AuthCallError'
  }
}

/** True when `list-sessions` refused a session older than Better Auth's `freshAge`. */
export function isNotFresh(error: unknown): boolean {
  return error instanceof AuthCallError && error.status === 403 && error.code === 'SESSION_NOT_FRESH'
}

/**
 * The error to throw for Better Auth's `error`. A 401 means the session ended, perhaps revoked on another device, so
 * the session is read again and the identity watcher takes the user to sign in. Better Auth's errors are not a
 * `ServerError`, so the watcher can't notice them on its own.
 */
function failure(queryClient: QueryClient, error: { status: number; code?: string }) {
  if (error.status === 401) void refetchSession(queryClient).catch(() => {})
  return new AuthCallError(error.status, error.code)
}

const systems: [RegExp, string][] = [
  [/iPhone|iPad|iPod/, 'iOS'],
  [/Android/, 'Android'],
  [/CrOS/, 'ChromeOS'],
  [/Windows/, 'Windows'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/Linux/, 'Linux'],
]

// Order matters: Edge and Opera also say Chrome, Chrome also says Safari, and iOS browsers all say Safari.
const browsers: [RegExp, string][] = [
  [/Edg(e|A|iOS)?\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Safari\//, 'Safari'],
]

/** A short name for the browser and system in `userAgent`, such as "Firefox on macOS", or "Unknown device". */
export function describeDevice(userAgent: string | null | undefined): string {
  const agent = userAgent ?? ''
  const system = systems.find(([pattern]) => pattern.test(agent))?.[1]
  const browser = browsers.find(([pattern]) => pattern.test(agent))?.[1]
  if (browser && system) return `${browser} on ${system}`
  return browser ?? system ?? 'Unknown device'
}

function iso(value: Date | string) {
  return new Date(value).toISOString()
}

/**
 * The query for the account's sessions, in the server's order, with the one this browser uses marked `current`. A session
 * older than a day can't list them: the query then fails with `isNotFresh`. It is never retried on its own.
 */
export function sessionsQuery(userId: string) {
  return queryOptions<SessionRow[], AuthCallError>({
    queryKey: accountKey(userId, 'sessions'),
    queryFn: async ({ client, signal }) => {
      const [list, current] = await Promise.all([
        authClient().listSessions({ fetchOptions: { signal } }),
        authClient().getSession({ fetchOptions: { signal } }),
      ])
      if (list.error) throw failure(client, list.error)
      if (current.error) throw failure(client, current.error)
      const currentId = current.data?.session.id
      return list.data.map((session) => ({
        id: session.id,
        device: describeDevice(session.userAgent),
        ipAddress: session.ipAddress || null,
        createdAt: iso(session.createdAt),
        lastActiveAt: iso(session.updatedAt),
        current: session.id === currentId,
      }))
    },
    retry: false,
  })
}

function invalidateSessions(queryClient: QueryClient, userId: string) {
  return queryClient.invalidateQueries({ queryKey: sessionsQuery(userId).queryKey })
}

/**
 * Ends one of `userId`'s sessions by its `id`, then reads the list again. `revoke-session` takes the token, so it is
 * looked up with a fresh `list-sessions` and lives only in this call. A session already gone counts as ended. Throws
 * an `AuthCallError` when the server refuses, leaving the list as it was.
 */
export async function revokeSession(queryClient: QueryClient, userId: string, id: string) {
  const list = await authClient().listSessions()
  if (list.error) throw failure(queryClient, list.error)
  const token = list.data.find((session) => session.id === id)?.token
  if (token) {
    const { error } = await authClient().revokeSession({ token })
    if (error) throw failure(queryClient, error)
  }
  await invalidateSessions(queryClient, userId)
}

/**
 * Ends every session of the account, this one included, then marks the session as signed out, which clears every
 * account's data from the cache. Throws an `AuthCallError` when the server refuses.
 */
export async function signOutEverywhere(queryClient: QueryClient) {
  const { error } = await authClient().revokeSessions()
  if (error) throw failure(queryClient, error)
  queryClient.setQueryData(sessionQuery.queryKey, null)
}

/**
 * Changes the password and ends every other session. Better Auth ends them all and starts a new one for this browser,
 * so the user stays signed in under a new session id; the token it answers is dropped. Then it reads the sessions list
 * again. Returns a message to show, or null once the password has changed.
 */
export async function changePassword(queryClient: QueryClient, currentPassword: string, newPassword: string) {
  const { error } = await authClient().changePassword({ currentPassword, newPassword, revokeOtherSessions: true })
  if (error) {
    failure(queryClient, error)
    if (error.code === 'INVALID_PASSWORD') return 'Your current password is wrong.'
    if (error.status === 429) return TOO_MANY_ATTEMPTS
    return 'Changing the password failed. Try again.'
  }
  const user = queryClient.getQueryData(sessionQuery.queryKey)
  if (user) await invalidateSessions(queryClient, user.id)
  return null
}
