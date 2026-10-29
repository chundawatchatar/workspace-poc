import type { Context } from 'hono'
import type { Authenticate, SessionPrincipal } from '../../lib/createServerRouter'
import type { Auth } from './auth.service'

/** What `authenticate` needs: only Better Auth's session lookup. */
export interface AuthenticateDeps {
  auth: { api: Pick<Auth['api'], 'getSession'> }
}

/**
 * Builds the `authenticate` hook for `createServerRouter`. It asks Better Auth
 * for the request's session, so a signed, unexpired and unrevoked session
 * cookie is the only way in, and it never reads the cookie itself.
 */
export function createAuthenticate({ auth }: AuthenticateDeps): Authenticate {
  return async (c: Context): Promise<SessionPrincipal | null> => {
    let session: Awaited<ReturnType<Auth['api']['getSession']>>
    try {
      // `disableRefresh` keeps this a pure read: a refresh would extend the session in the database but set the
      // longer cookie on a response this hook can't touch. Better Auth's own `/api/auth/get-session` refreshes both.
      session = await auth.api.getSession({ headers: c.req.raw.headers, query: { disableRefresh: true } })
    } catch (error) {
      throw new SessionLookupError(error)
    }
    if (!session) return null
    const { id, email, name } = session.user
    return { userId: id, email, name }
  }
}

/**
 * Reading the session failed, for example because the database is down. The
 * original error is dropped, since a database error quotes the query's
 * parameters, which include the session token. Only its name and code remain.
 */
export class SessionLookupError extends Error {
  override name = 'SessionLookupError'

  constructor(cause: unknown) {
    super(`Reading the session failed${describeCause(cause)}.`)
  }
}

function describeCause(cause: unknown): string {
  if (!(cause instanceof Error)) return ''
  const code = (cause as { code?: unknown }).code
  return typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? `: ${cause.name} (${code})` : `: ${cause.name}`
}
