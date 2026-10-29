import { z } from 'zod'

/** The settings for the accounts side: the database, Better Auth and the mailer. */
export interface AccountsConfig {
  databaseUrl: string
  /** At least 32 bytes. Never log it. */
  betterAuthSecret: string
  /** The server's public URL, which Better Auth puts in links. */
  betterAuthUrl: string
  smtpUrl: string
  mailFrom: string
}

/** The server's validated settings. */
export interface ServerConfig {
  /** Null means accounts are off (`DATABASE_URL` is unset), so only the relay, the client and `/api/health` run. */
  accounts: AccountsConfig | null
  /** Exact origins, besides the server's own, that may send non-GET requests to the server API. */
  trustedOrigins: string[]
}

/** Thrown by `loadServerConfig`. The message names each bad variable and why, never its value. */
export class ServerConfigError extends Error {
  override name = 'ServerConfigError'
}

const MIN_SECRET_BYTES = 32

// An empty value counts as unset, as it does in most `.env` loaders.
const blankAsUnset = (value: unknown) => (typeof value === 'string' && value.trim() === '' ? undefined : value)

const required = z.string({ error: 'is required' })

function urlWithProtocol(protocols: string[], message: string) {
  return required.refine((value) => {
    try {
      return protocols.includes(new URL(value).protocol)
    } catch {
      return false
    }
  }, message)
}

/** True when `value` is an http(s) origin and nothing else: no path, query or trailing slash. */
function isExactOrigin(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value
  } catch {
    return false
  }
}

const trustedOrigins = z
  .string()
  .optional()
  .transform((value) =>
    (value ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  )
  .superRefine((origins, ctx) => {
    origins.forEach((origin, index) => {
      if (!isExactOrigin(origin)) {
        ctx.addIssue({
          code: 'custom',
          message: `entry ${index + 1} is not an exact origin (scheme://host[:port], no path or trailing slash)`,
        })
      }
    })
  })

const baseSchema = z.object({
  SERVER_TRUSTED_ORIGINS: z.preprocess(blankAsUnset, trustedOrigins),
})

const accountsSchema = z.object({
  DATABASE_URL: z.preprocess(blankAsUnset, urlWithProtocol(['postgres:', 'postgresql:'], 'must be a postgres:// URL')),
  BETTER_AUTH_SECRET: z.preprocess(
    blankAsUnset,
    required.refine(
      (value) => new TextEncoder().encode(value).length >= MIN_SECRET_BYTES,
      `must be at least ${MIN_SECRET_BYTES} bytes`,
    ),
  ),
  BETTER_AUTH_URL: z.preprocess(
    blankAsUnset,
    urlWithProtocol(['http:', 'https:'], 'must be an http:// or https:// URL'),
  ),
  SMTP_URL: z.preprocess(blankAsUnset, urlWithProtocol(['smtp:', 'smtps:'], 'must be an smtp:// or smtps:// URL')),
  MAIL_FROM: z.preprocess(blankAsUnset, required),
})

/**
 * Reads and checks the server's settings from `env`. Accounts are on only
 * when `DATABASE_URL` is set, and then every accounts variable is required.
 * Throws a `ServerConfigError` listing every problem.
 */
export function loadServerConfig(env: Record<string, string | undefined>): ServerConfig {
  const problems: string[] = []
  const base = baseSchema.safeParse(env)
  if (!base.success) problems.push(...describe(base.error))
  const accounts = blankAsUnset(env.DATABASE_URL) !== undefined ? accountsSchema.safeParse(env) : null
  if (accounts && !accounts.success) problems.push(...describe(accounts.error))
  if (problems.length > 0 || !base.success) {
    throw new ServerConfigError(`Invalid server settings:\n${problems.map((line) => `  - ${line}`).join('\n')}`)
  }
  return {
    trustedOrigins: base.data.SERVER_TRUSTED_ORIGINS,
    accounts: accounts?.success
      ? {
          databaseUrl: accounts.data.DATABASE_URL,
          betterAuthSecret: accounts.data.BETTER_AUTH_SECRET,
          betterAuthUrl: accounts.data.BETTER_AUTH_URL,
          smtpUrl: accounts.data.SMTP_URL,
          mailFrom: accounts.data.MAIL_FROM,
        }
      : null,
  }
}

// Only the variable name and our own message: Zod's issues can carry the input, which may be a secret.
function describe(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${String(issue.path[0] ?? 'environment')}: ${issue.message}`)
}
