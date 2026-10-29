import { type AnyPgDatabase, type Domain, schema } from '@orch/domain'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import type { Mailer } from '../mailer/mailer.service'

/** The header the routes set to the client IP the server trusts, replacing any value the client sent. */
export const CLIENT_IP_HEADER = 'x-orch-client-ip'

/** What the auth module is built from. */
export interface AuthDeps {
  /** Only `forAuthLibrary()` is used, so a domain on Bun SQL and one on PGlite both fit. */
  domain: Pick<Domain<never, AnyPgDatabase>, 'forAuthLibrary'>
  mailer: Mailer
  /** `BETTER_AUTH_SECRET`, at least 32 bytes. Never log it. */
  secret: string
  /** `BETTER_AUTH_URL`, the server's public URL. Its origin is trusted, and email links start with it. */
  baseUrl: string
  /** Exact origins, besides the server's own, that may send non-GET requests (`SERVER_TRUSTED_ORIGINS`). */
  trustedOrigins: readonly string[]
}

/**
 * Builds the Better Auth instance behind `/api/auth/*`: email and password
 * with required verification, sessions in the database and never cached in a
 * cookie, and a session cookie on `Path=/api`, so browsers never send it to
 * the relayed machines under `/m/*`.
 */
export function createAuth({ domain, mailer, secret, baseUrl, trustedOrigins }: AuthDeps) {
  return betterAuth({
    secret,
    baseURL: baseUrl,
    basePath: '/api/auth',
    trustedOrigins: [...trustedOrigins],
    database: drizzleAdapter(domain.forAuthLibrary(), { provider: 'pg', schema }),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: ({ user, url }) => mailer.send(user.email, 'resetPassword', { url }),
    },
    emailVerification: {
      sendOnSignUp: true,
      sendVerificationEmail: ({ user, url }) => mailer.send(user.email, 'verifyEmail', { url }),
    },
    // Every request reads the session from the database, so a revoked session ends at once.
    session: { cookieCache: { enabled: false } },
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
