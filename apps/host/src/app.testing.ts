import type { Hono } from 'hono'

// Test-only helpers for calling a `createApp` app as this machine would. Never
// imported by production code.

/** The port the tests pretend the host listens on. */
export const LOCAL_PORT = 4599

/** The env Bun's server gives a local request: only its `port` is read. */
export const localEnv = { port: LOCAL_PORT }

/** Sends a request to `app` as a local caller: with this host's own `Host` unless `init` sets one, and `localEnv`. */
export function localRequest(app: Hono, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  if (!headers.has('host')) headers.set('host', `127.0.0.1:${LOCAL_PORT}`)
  return app.request(path, { ...init, headers }, localEnv)
}
