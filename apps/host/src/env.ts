import { join } from 'node:path'
import { loadRootEnv, optionalEnv, repoRoot, urlFromEnv } from '@orch/shared/env'
import { daemonRuntimeDir } from './modules/terminals/daemon.repository'

// Imported first by every dev host entry point, so the root `.env` is loaded before any module reads `process.env`.
// It also holds the dev host's folders, all found from the repo, so no module needs to know where the repo is.
loadRootEnv()

export { repoRoot }

/** The host's own address, from `HOST_HOST` and `HOST_PORT`, for the CLI commands that call a running host. */
export function hostUrl(): string {
  return urlFromEnv('HOST_HOST', 'HOST_PORT')
}

/** Where the dev host keeps its files. */
export const devDataDir = join(repoRoot, 'apps', 'host', '.data')

/**
 * The dev daemon's runtime folder: `ORCH_PTY_RUNTIME` when it is set, else the one derived from `devDataDir`, which
 * is the folder a dev host used before the data folder was a setting, so it attaches to the daemon already running.
 */
export function devDaemonRuntime(): string {
  return optionalEnv('ORCH_PTY_RUNTIME') ?? daemonRuntimeDir(devDataDir, process.getuid?.() ?? 'user')
}

/** The dev terminal daemon's source folder, whose files name the build of a host run from source. */
export const devDaemonSourceDir = join(repoRoot, 'apps', 'ptyd-bun', 'src')

/** Starts the dev terminal daemon from its source. */
export const devDaemonCommand = [process.execPath, join(devDaemonSourceDir, 'main.ts')]
