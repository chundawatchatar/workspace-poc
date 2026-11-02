import { HttpResponse } from 'msw'

// Better Auth's JSON, as the cloud server answers `/api/auth/*`, for MSW handlers. Kept in one place so every test
// answers with the same real shapes. Values are fakes.

const at = '2026-10-30T09:30:00.000Z'

/** A user as Better Auth answers it. */
export function authUser({ id, email, name }: { id: string; email: string; name: string }) {
  return { id, email, name, emailVerified: true, image: null, createdAt: at, updatedAt: at }
}

/** A session as Better Auth answers it, token included, as `get-session` and `list-sessions` do. */
export function authSession(id: string, userId: string, fields: Partial<Record<string, string | null>> = {}) {
  return {
    id,
    token: `token-${id}`,
    userId,
    expiresAt: '2026-11-06T09:30:00.000Z',
    createdAt: at,
    updatedAt: at,
    ipAddress: null,
    userAgent: null,
    ...fields,
  }
}

/** Better Auth's error answer: `{ code, message }` with its HTTP status. */
export function authError(status: number, code: string, message: string) {
  return HttpResponse.json({ code, message }, { status })
}

/** Better Auth's rate limiter, which answers before any endpoint, with a message and no code. */
export function rateLimited() {
  return HttpResponse.json({ message: 'Too many requests. Please try again later.' }, { status: 429 })
}
