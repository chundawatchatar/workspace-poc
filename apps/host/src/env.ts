import { loadRootEnv, urlFromEnv } from '@orch/shared/env'

// Imported first by every host entry point, so the root `.env` is loaded before any module reads `process.env`.
loadRootEnv()

/** The host's own address, from `HOST_HOST` and `HOST_PORT`, for the CLI commands that call a running host. */
export function hostUrl(): string {
  return urlFromEnv('HOST_HOST', 'HOST_PORT')
}
