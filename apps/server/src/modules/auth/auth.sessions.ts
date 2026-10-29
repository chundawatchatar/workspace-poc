import { type AnyPgDatabase, schema } from '@orch/domain'
import { eq } from 'drizzle-orm'

/** What `revokeUserSessions` did. `found` is false when no user has that email, and then nothing was deleted. */
export interface RevokeResult {
  found: boolean
  revoked: number
}

/**
 * Deletes every session of the user with `email`, for an operator handling a
 * compromised account. Each of those sessions is refused on its next request,
 * since the session is read from the database every time. The email is
 * trimmed and lower-cased, as Better Auth stores it. `db` sees every user's
 * rows, so only an operator script passes it in, from `skipAuthorization`.
 * Nothing is logged.
 */
export async function revokeUserSessions(db: AnyPgDatabase, email: string): Promise<RevokeResult> {
  const [user] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, email.trim().toLowerCase()))
  if (!user) return { found: false, revoked: 0 }
  const deleted = await db
    .delete(schema.session)
    .where(eq(schema.session.userId, user.id))
    .returning({ id: schema.session.id })
  return { found: true, revoked: deleted.length }
}
