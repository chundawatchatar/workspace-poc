import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Server-side only: this file uses `node:fs`, so it is published as `@orch/shared/env` and kept out of `index.ts`,
// which browser code imports.

/**
 * The repo's `.env`, found from this file so it loads whatever the working directory is. Resolved from
 * `import.meta.url`, so it also works where Node runs it: the Vite and Astro configs.
 */
export const rootEnvPath = fileURLToPath(new URL('../../../.env', import.meta.url))

/**
 * Parses `.env` text into key/value pairs. Supports blank lines, `#` comments,
 * an optional `export ` prefix, single and double quotes, and trailing
 * comments after unquoted values. It does no variable expansion.
 */
export function parseEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match) continue
    values[match[1] as string] = parseValue(match[2] as string)
  }
  return values
}

function parseValue(rest: string): string {
  const quote = rest[0]
  if (quote === '"' || quote === "'") {
    const end = rest.indexOf(quote, 1)
    if (end > 0) {
      const inner = rest.slice(1, end)
      return quote === '"' ? inner.replace(/\\n/g, '\n') : inner
    }
  }
  // A `#` starts a comment only after whitespace, so values such as URL fragments keep theirs.
  return rest.replace(/\s+#.*$/, '').trim()
}

/**
 * Loads the repo's root `.env` into `env`, setting only the variables that are
 * not already set, so the real environment wins. A missing file is a no-op.
 * Server-side entry points (and a future `drizzle.config.ts`) call it before
 * reading `process.env`, because Bun only auto-loads `.env` from the working
 * directory. `path` and `env` are there for tests.
 */
export function loadRootEnv(options: { path?: string; env?: Record<string, string | undefined> } = {}): void {
  const path = options.path ?? rootEnvPath
  const env = options.env ?? process.env
  if (!existsSync(path)) return
  for (const [key, value] of Object.entries(parseEnv(readFileSync(path, 'utf8')))) {
    if (env[key] === undefined) env[key] = value
  }
}

/** Reads a setting that may be left out: an unset or blank one is `undefined`, so `KEY=` in `.env` means unset. */
export function optionalEnv(key: string, env: Record<string, string | undefined> = process.env): string | undefined {
  return env[key]?.trim() || undefined
}

/**
 * Reads a setting that must come from the env, such as an address or a port: nothing has a default in code, so the
 * env is the one place to change it. Throws with the variable's name, never a value, when it is unset or blank.
 */
export function requiredEnv(key: string, env: Record<string, string | undefined> = process.env): string {
  const value = env[key]?.trim()
  if (!value)
    throw new Error(`${key} is not set. Copy .env.example to .env at the repo root, or set it in the environment.`)
  return value
}

/**
 * `http://<host>:<port>` from a host and a port setting, such as `HOST_HOST` and `HOST_PORT`. An IPv6 address such
 * as `::1` gets the brackets a URL needs.
 */
export function urlFromEnv(hostKey: string, portKey: string, env: Record<string, string | undefined> = process.env) {
  const host = requiredEnv(hostKey, env)
  return `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${requiredEnv(portKey, env)}`
}
