import { dirname, resolve } from 'node:path'
import { optionalEnv, requiredEnv, rootEnvPath } from '@orch/shared/env'
import { parseAllowedOrigins } from './security'

type Env = Record<string, string | undefined>

/** The relay's own settings, read from the env with no defaults in code. */
export interface RelaySettings {
  /** At most this many open channels per machine (`SERVER_MAX_CHANNELS`). */
  maxChannelsPerMachine: number
  /** How long a relayed HTTP request may wait for its machine (`SERVER_REQUEST_TIMEOUT_MS`). */
  requestTimeoutMs: number
  /** The absolute folder the built client is served from (`SERVER_STATIC_DIR`). */
  staticDir: string
  /** Exact origins that may call the machine routes cross-origin (`SERVER_ALLOWED_ORIGINS`). */
  allowedOrigins: string[]
  /** Whether to read the client IP from `X-Forwarded-For` (`SERVER_TRUST_PROXY=1`). */
  trustProxy: boolean
}

// The folder of the root `.env`, so a relative `SERVER_STATIC_DIR` means the same folder however the server starts.
const repoRoot = dirname(rootEnvPath)

/** Reads the relay's settings from `env`. Throws with a variable's name, never its value, when one is missing or bad. */
export function loadRelaySettings(env: Env): RelaySettings {
  return {
    maxChannelsPerMachine: positiveInteger('SERVER_MAX_CHANNELS', env),
    requestTimeoutMs: positiveInteger('SERVER_REQUEST_TIMEOUT_MS', env),
    staticDir: resolve(repoRoot, requiredEnv('SERVER_STATIC_DIR', env)),
    allowedOrigins: parseAllowedOrigins(optionalEnv('SERVER_ALLOWED_ORIGINS', env)),
    trustProxy: optionalEnv('SERVER_TRUST_PROXY', env) === '1',
  }
}

function positiveInteger(key: string, env: Env): number {
  const text = requiredEnv(key, env)
  const value = Number(text)
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < 1)
    throw new Error(`${key} must be a positive integer.`)
  return value
}
