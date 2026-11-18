import { BASE_ERROR_CODES, type BetterAuthPlugin, type GenericEndpointContext } from 'better-auth'
import { APIError, createAuthEndpoint, formCsrfMiddleware, isAPIError } from 'better-auth/api'
import type { emailOTP } from 'better-auth/plugins/email-otp'
import * as z from 'zod'

/** The `emailOTP` plugin's `sign-in/email-otp` step, which this plugin calls server-side only. */
export type RedeemCodeStep = ReturnType<typeof emailOTP>['endpoints']['signInEmailOTP']

/** What the email-code sign-up is built from. */
export interface SignUpCodeOptions {
  /** The `signInEmailOTP` endpoint of the `emailOTP` plugin the auth instance runs, so both share its options. */
  redeemCode: RedeemCodeStep
  /**
   * Test-only: runs just before the password is saved, and a throw makes that
   * write fail. Never set from env or reachable over HTTP.
   */
  beforeCredentialWrite?: () => unknown
}

/** The one answer for every refused code: wrong, used up, locked, expired, or for an address that has an account. */
export const SIGN_UP_CODE_REFUSED = { code: 'INVALID_OR_EXPIRED_CODE', message: 'Invalid or expired code' } as const

const bodySchema = z.object({
  name: z.string(),
  email: z.email(),
  password: z.string(),
  code: z.string(),
})

/**
 * A Better Auth plugin with one endpoint, `POST /sign-up/email-code`, that
 * turns a code from `email-otp/send-verification-otp` (type `sign-in`) plus a
 * name and password into a new, verified, signed-in account with a password.
 * It never signs in to or changes an account that already exists, and it
 * accepts a correct code once, also under concurrent requests.
 */
export function signUpByEmailCode({ redeemCode, beforeCredentialWrite }: SignUpCodeOptions) {
  return {
    id: 'sign-up-email-code',
    endpoints: {
      signUpEmailCode: createAuthEndpoint(
        '/sign-up/email-code',
        { method: 'POST', use: [formCsrfMiddleware], body: bodySchema },
        async (ctx) => {
          const { name, password, code } = ctx.body
          const email = ctx.body.email.toLowerCase()
          const { minPasswordLength, maxPasswordLength } = ctx.context.password.config
          // Checked before the code is touched, so a bad password costs no attempt and leaves the code usable.
          if (password.length < minPasswordLength)
            throw APIError.from('BAD_REQUEST', BASE_ERROR_CODES.PASSWORD_TOO_SHORT)
          if (password.length > maxPasswordLength)
            throw APIError.from('BAD_REQUEST', BASE_ERROR_CODES.PASSWORD_TOO_LONG)
          // Hashed before the user exists, so a failing hash neither spends the code nor leaves a user behind.
          const hash = await ctx.context.password.hash(password)

          // The step runs outside any transaction, so a wrong code's attempt count is kept when this request fails.
          const step = await redeemOnlyForNewUser(ctx, redeemCode, { email, name, code })
          const userId = step.response.user.id

          try {
            await beforeCredentialWrite?.()
            await ctx.context.internalAdapter.linkAccount({
              userId,
              providerId: 'credential',
              accountId: userId,
              password: hash,
            })
          } catch {
            // The code is spent either way; a user with no password and an unused session must not stay behind.
            await ctx.context.internalAdapter.deleteUser(userId).catch(() => {
              console.error('auth: removing a half-created email-code sign-up failed')
            })
            throw refused()
          }

          for (const cookie of step.headers.getSetCookie()) ctx.responseHeaders.append('set-cookie', cookie)
          return ctx.json(step.response)
        },
      ),
    },
  } satisfies BetterAuthPlugin
}

/**
 * Runs the `sign-in/email-otp` step in a copy of the request's context in
 * which no user is ever found by email. The step then uses the code up, counts
 * a wrong one and always takes its create branch: a new user with the name
 * and `emailVerified: true`, in one insert, and a session. The step is called
 * as a plain function, so no hooks run and its cookie is kept in its own
 * headers until the password is saved. When the address already has an
 * account, the email's unique constraint fails that insert, so the step can
 * never sign in to, promote or revoke the sessions of a user it did not create,
 * however a concurrent sign-up interleaves. Every refusal looks the same.
 */
async function redeemOnlyForNewUser(
  ctx: GenericEndpointContext,
  redeemCode: RedeemCodeStep,
  { email, name, code }: { email: string; name: string; code: string },
) {
  const internalAdapter = { ...ctx.context.internalAdapter, findUserByEmail: async () => null }
  try {
    return await redeemCode({
      body: { email, otp: code, name },
      context: { ...ctx.context, internalAdapter },
      headers: ctx.headers,
      request: ctx.request,
      returnHeaders: true,
    })
  } catch (error) {
    if (isAPIError(error)) throw refused()
    // A failed insert for an address that has an account is the duplicate case; anything else is a real fault.
    if (await ctx.context.internalAdapter.findUserByEmail(email)) throw refused()
    throw error
  }
}

function refused() {
  return APIError.from('BAD_REQUEST', SIGN_UP_CODE_REFUSED)
}
