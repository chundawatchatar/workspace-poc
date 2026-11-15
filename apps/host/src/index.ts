import './env'
import { resolve } from 'node:path'
import { optionalEnv, requiredEnv } from '@orch/shared/env'
import { daemonBuild, embeddedBuildId } from '@orch/terminal'
import { selfCommand } from './cli/self'
import { devDaemonCommand, devDaemonRuntime, devDaemonSourceDir, devDataDir, repoRoot } from './env'
import { startHost } from './host'
import { migrateRemoteAccessAddresses, readSettingsFile, settingsPath } from './modules/settings/settings.repository'
import { loadSettings, SETTINGS_DEFAULTS, type Settings } from './modules/settings/settings.service'
import { daemonCommand } from './modules/terminals/daemon-build'
import { loadUiSite } from './modules/ui/ui.service'

// The dev host: its folders come from `env.ts`, its address from `HOST_HOST` and `HOST_PORT`, and its UI from
// `HOST_STATIC_DIR`. The packaged `corch` starts the same host from `cli/run.ts`.

const dataDir = devDataDir
const projectRoot = repoRoot

// Before anything starts: a folder from before `config.json` is migrated, and a settings file that can't be used
// stops the host with a message naming the setting. Dev reads no `CORCH_*` variables and keeps `HOST_PORT`.
let settings: Settings
try {
  migrateRemoteAccessAddresses(dataDir)
  settings = loadSettings({
    flags: {},
    env: {},
    file: readSettingsFile(settingsPath(dataDir)),
    defaults: SETTINGS_DEFAULTS,
  })
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}

// The built local UI, served on the host's own port. Unset serves none; a relative path resolves from the repo root.
const staticDir = optionalEnv('HOST_STATIC_DIR')
const uiDir = staticDir === undefined ? null : resolve(projectRoot, staticDir)
const ui = uiDir === null ? null : await loadUiSite(uiDir)
if (uiDir !== null && !ui) {
  console.error(`HOST_STATIC_DIR has no index.html: ${uiDir}`)
  process.exit(1)
}

// A compiled host carries its build id, and runs the daemon from its own executable; from source it runs the
// daemon's entry file, and both sides hash the daemon's sources.
const packaged = embeddedBuildId() !== null
startHost({
  dataDir,
  projectRoot,
  settings,
  daemonRuntime: devDaemonRuntime(),
  daemonCommand: daemonCommand({ packaged, self: selfCommand(), dev: devDaemonCommand }),
  build: daemonBuild(devDaemonSourceDir),
  ui,
  packaged,
  addresses: { SERVER_URL: optionalEnv('SERVER_URL'), CLIENT_URL: optionalEnv('CLIENT_URL') },
  hostname: requiredEnv('HOST_HOST'),
  port: Number(requiredEnv('HOST_PORT')),
})
