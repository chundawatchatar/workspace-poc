import { type AnyPgDatabase, type Domain, schema } from '@orch/domain'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { emailOTP } from 'better-auth/plugins/email-otp'
import type { Mailer } from '../mailer/mailer.service'
import { signUpByEmailCode } from './auth.sign-up-code'

/** The header the routes set to the client IP the server trusts, replacing any value the client sent. */
export const CLIENT_IP_HEADER = 'x-orch-client-ip'

/** What the auth module is built from. */
export interface AuthDeps {
  /** Only `forAuthLibrary()` is used, so a domain on Bun SQL and one on PGlite both fit. */
  domain: Pick<Domain<never, AnyPgDatabase>, 'forAuthLibrary'>
  mailer: Mailer
  /** `BETTER_AUTH_SECRET`, at least 32 bytes. Never log it. */
  secret: string
  /** `BETTER_AUTH_URL`, the server's public URL. Its origin is trusted, and email links go to client pages on it. */
  baseUrl: string
  /** Exact origins, besides the server's own, that may send non-GET requests (`SERVER_TRUSTED_ORIGINS`). */
  trustedOrigins: readonly string[]
  /**
   * Told the user id of every session row Better Auth deletes: a revoke, a
   * sign-out, a password change that ends other sessions or a password reset.
   * It is not awaited, and a throw or rejection is logged and dropped, so a
   * sign-out never waits for it or fails because of it.
   */
  onSessionEnded?: (userId: string) => unknown
  /**
   * Test-only: runs inside the email-code sign-up just before it saves the
   * password, and a throw makes that write fail. Never set from env.
   */
  beforeSignUpCredentialWrite?: () => unknown
}

/**
 * The `emailOTP` paths the client never calls, closed over HTTP. The email-code
 * sign-up still runs the `sign-in/email-otp` step server-side, since Better
 * Auth checks `disabledPaths` only in its HTTP router.
 */
export const DISABLED_EMAIL_OTP_PATHS = [
  '/sign-in/email-otp',
  '/email-otp/check-verification-otp',
  '/email-otp/verify-email',
  '/email-otp/request-password-reset',
  '/forget-password/email-otp',
  '/email-otp/reset-password',
  '/email-otp/request-email-change',
  '/email-otp/change-email',
]

/**
 * Builds the Better Auth instance behind `/api/auth/*`: email and password
 * with required verification, sign-up by an emailed code
 * (`email-otp/send-verification-otp`, then `sign-up/email-code`), sessions in
 * the database and never cached in a cookie, and a session cookie on
 * `Path=/api`, so browsers never send it to the relayed machines under `/m/*`.
 */
export function createAuth({
  domain,
  mailer,
  secret,
  baseUrl,
  trustedOrigins,
  onSessionEnded,
  beforeSignUpCredentialWrite,
}: AuthDeps) {
  const otp = emailOTP({
    storeOTP: 'hashed',
    // Length 6, 300 seconds, 3 attempts and the rate limits stay the plugin's defaults. An address with an account
    // gets `accountExists` and never a code, whatever the type; a new address gets its code only for `sign-in`.
    // The plugin answers `{ success: true }` either way, so the answer never says which addresses have accounts.
    sendVerificationOTP: async ({ email, otp, type }, ctx) => {
      if (!ctx) throw new Error('auth: a sign-up code was asked for outside a request')
      if (await ctx.context.internalAdapter.findUserByEmail(email)) {
        const origin = new URL(baseUrl).origin
        await mailer.send(email, 'accountExists', {
          signInUrl: `${origin}/auth/sign-in`,
          forgotPasswordUrl: `${origin}/auth/forgot-password`,
        })
      } else if (type === 'sign-in') {
        await mailer.send(email, 'signUpCode', { code: otp })
      }
    },
  })
  return betterAuth({
    secret,
    baseURL: baseUrl,
    basePath: '/api/auth',
    trustedOrigins: [...trustedOrigins],
    database: drizzleAdapter(domain.forAuthLibrary(), { provider: 'pg', schema, transaction: true }),
    plugins: [
      otp,
      signUpByEmailCode({
        redeemCode: otp.endpoints.signInEmailOTP,
        beforeCredentialWrite: beforeSignUpCredentialWrite,
      }),
    ],
    disabledPaths: [...DISABLED_EMAIL_OTP_PATHS],
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: ({ user, token }) =>
        mailer.send(user.email, 'resetPassword', { url: emailLinkUrl(baseUrl, 'reset-password', token) }),
    },
    emailVerification: {
      sendOnSignUp: true,
      sendVerificationEmail: ({ user, token }) =>
        mailer.send(user.email, 'verifyEmail', { url: emailLinkUrl(baseUrl, 'verify-email', token) }),
    },
    session: {
      // Every request reads the session from the database, so a revoked session ends at once.
      cookieCache: { enabled: false },
      // Better Auth's default of one day, in seconds. `list-sessions` answers 403 `SESSION_NOT_FRESH` for a session
      // older than this, so a page that lists devices must ask for a fresh sign-in first. Revoking needs no freshness.
      freshAge: 60 * 60 * 24,
    },
    // Runs once per deleted row, the bulk deletes of `revoke-sessions` and `revoke-other-sessions` included.
    databaseHooks: {
      session: { delete: { after: async (session) => notifySessionEnded(onSessionEnded, session.userId) } },
    },
    // Better Auth turns these off when `NODE_ENV` is `test`; set them so tests see what production does.
    rateLimit: { enabled: true, storage: 'memory' },
    advanced: {
      disableOriginCheck: false,
      defaultCookieAttributes: { path: '/api', secure: true, httpOnly: true, sameSite: 'lax' },
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
    },
    telemetry: { enabled: false },
    logger: { level: 'warn', log: logAuthLine },
  })
}

/**
 * The link an email carries to the client's `/auth/<page>` on the origin of
 * `baseUrl`, with the token in the fragment: browsers never send a fragment to
 * a server, so the token stays out of access logs and `Referer`. The client
 * reads it and removes it from the address bar before its router starts.
 */
export function emailLinkUrl(baseUrl: string, page: 'verify-email' | 'reset-password', token: string): string {
  return `${new URL(baseUrl).origin}/auth/${page}#token=${encodeURIComponent(token)}`
}

/** Calls `onSessionEnded` without waiting for it, logging a fixed line, never the user id, if it fails. */
function notifySessionEnded(onSessionEnded: AuthDeps['onSessionEnded'], userId: string) {
  if (!onSessionEnded) return
  const failed = () => console.error('auth: telling machines that a session ended failed')
  try {
    Promise.resolve(onSessionEnded(userId)).catch(failed)
  } catch {
    failed()
  }
}

/** A Better Auth instance from `createAuth`. */
export type Auth = ReturnType<typeof createAuth>

/**
 * Writes one Better Auth log line. Its messages can quote an email address, a
 * URL or a token, so those are masked, and of any extra value only an error's
 * name and code are kept: a database error can carry the query's parameters.
 */
function logAuthLine(level: 'debug' | 'info' | 'warn' | 'error', message: string, ...args: unknown[]) {
  const details = args.map(describeLogValue).filter(Boolean)
  const line = [`auth ${level}: ${redactLogText(message)}`, ...details].join(' ')
  if (level === 'error') console.error(line)
  else console.warn(line)
}

/** Masks email addresses, the path and query of URLs, and long token-like strings in a log message. */
function redactLogText(text: string): string {
  return text
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, (url) => {
      // A bare origin, as in "Invalid origin", helps to debug and carries no secret.
      try {
        const { origin } = new URL(url)
        return origin !== 'null' && (url === origin || url === `${origin}/`) ? origin : `${origin}/[redacted]`
      } catch {
        return '[url]'
      }
    })
    .replace(/[^\s@<>"'`(),;:]+@[^\s@<>"'`(),;:]+/g, '[email]')
    .replace(/[A-Za-z0-9_-]{24,}/g, '[token]')
}

// Only the error's name and an upper-case code, never its message, which may quote input.
function describeLogValue(value: unknown): string {
  if (!(value instanceof Error)) return ''
  const code = (value as { code?: unknown }).code
  return typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? `${value.name} (${code})` : value.name
}
