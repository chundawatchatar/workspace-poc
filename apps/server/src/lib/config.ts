import { parseServerUrl, type RelayKey, relayKey } from '@orch/shared'
import { z } from 'zod'

/** The accounts settings: the database, Better Auth, the mailer, relay tickets and the tunnel address. */
export interface AccountsConfig {
  databaseUrl: string
  /** At least 32 bytes. Never log it. */
  betterAuthSecret: string
  /** The server's public URL, which Better Auth puts in links. */
  betterAuthUrl: string
  smtpUrl: string
  mailFrom: string
  /** `RELAY_SIGNING_KEY`: the Ed25519 key relay tickets are signed with. Never log its seed. */
  relaySigningKey: { kid: string; seed: string }
  /** `RELAY_EXTRA_PUBLIC_KEYS`: public keys machines also trust, for a key rotation. */
  relayExtraPublicKeys: RelayKey[]
  /**
   * `SERVER_TUNNEL_URL`: the address machines open their tunnel to on this
   * server, `wss://<host>` or `ws://` on a loopback host, with no path. Every
   * new enrollment key comes with it.
   */
  serverTunnelUrl: string
}

/** The server's validated settings. */
export interface ServerConfig {
  /** Every one of them is required, so a server without them refuses to start. */
  accounts: AccountsConfig
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

// `<kid>:<value>`, with a 1 to 32 character key id and a 32-byte value in unpadded base64url.
const KEY_ENTRY = /^([A-Za-z0-9_-]{1,32}):([A-Za-z0-9_-]{43})$/

const relaySigningKey = required
  .regex(KEY_ENTRY, 'must be <kid>:<32-byte seed as base64url>; run `bun apps/server/scripts/relay-key.ts`')
  .transform((value) => {
    const [, kid = '', seed = ''] = KEY_ENTRY.exec(value) ?? []
    return { kid, seed }
  })

/**
 * A server address as `parseServerUrl` takes it, with no path, query or
 * fragment, normalised to `scheme://host[:port]`.
 */
const serverTunnelUrl = required
  .refine((value) => {
    if (!parseServerUrl(value)) return false
    const url = new URL(value)
    return url.pathname === '/' || url.pathname === ''
  }, 'must be wss://<host>, or ws:// on 127.0.0.1, [::1] or localhost, with no path')
  .transform((value) => new URL(value).origin)

const relayExtraPublicKeys = z
  .string()
  .optional()
  .transform((value) =>
    (value ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  )
  .pipe(
    z.array(
      z
        .string()
        .regex(KEY_ENTRY, 'each entry must be <kid>:<32-byte public key as base64url>')
        .transform((entry): RelayKey => {
          const [, kid = '', publicKey = ''] = KEY_ENTRY.exec(entry) ?? []
          return relayKey.parse({ kid, publicKey })
        }),
    ),
  )

const schema = z.object({
  SERVER_TRUSTED_ORIGINS: z.preprocess(blankAsUnset, trustedOrigins),
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
  RELAY_SIGNING_KEY: z.preprocess(blankAsUnset, relaySigningKey),
  RELAY_EXTRA_PUBLIC_KEYS: z.preprocess(blankAsUnset, relayExtraPublicKeys),
  SERVER_TUNNEL_URL: z.preprocess(blankAsUnset, serverTunnelUrl),
})

/**
 * Reads and checks the server's settings from `env`. Every accounts variable
 * is required; `RELAY_EXTRA_PUBLIC_KEYS` and `SERVER_TRUSTED_ORIGINS` are
 * optional. Throws a `ServerConfigError` listing every problem.
 */
export function loadServerConfig(env: Record<string, string | undefined>): ServerConfig {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    const problems = describe(parsed.error).map((line) => `  - ${line}`)
    throw new ServerConfigError(`Invalid server settings:\n${problems.join('\n')}`)
  }
  const { data } = parsed
  return {
    trustedOrigins: data.SERVER_TRUSTED_ORIGINS,
    accounts: {
      databaseUrl: data.DATABASE_URL,
      betterAuthSecret: data.BETTER_AUTH_SECRET,
      betterAuthUrl: data.BETTER_AUTH_URL,
      smtpUrl: data.SMTP_URL,
      mailFrom: data.MAIL_FROM,
      relaySigningKey: data.RELAY_SIGNING_KEY,
      relayExtraPublicKeys: data.RELAY_EXTRA_PUBLIC_KEYS,
      serverTunnelUrl: data.SERVER_TUNNEL_URL,
    },
  }
}

// Only the variable name and our own message: Zod's issues can carry the input, which may be a secret.
function describe(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${String(issue.path[0] ?? 'environment')}: ${issue.message}`)
}
