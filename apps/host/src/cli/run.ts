import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { embeddedBuildId } from '@orch/terminal'
import { startHost } from '../host'
import { migrateRemoteAccessAddresses, readSettingsFile, settingsPath } from '../modules/settings/settings.repository'
import { loadSettings, type SettingFlag, type Settings } from '../modules/settings/settings.service'
import { daemonRuntimeDir } from '../modules/terminals/daemon.repository'
import { daemonCommand } from '../modules/terminals/daemon-build'
import { loadEmbeddedUiSite, type UiSite } from '../modules/ui/ui.service'
import { ensureDataFolder } from './data-folder'
import { embeddedUi } from './embedded-ui'
import { hostState, LOCK_HELD_EXIT } from './lifecycle'
import { CappedLog, captureConsole, logPath } from './log-writer'
import { acquireLock, type LockRecord, removeProcessFiles, writeRunFile } from './process-files'
import { selfCommand } from './self'

/** What `run` needs: the data folder, the setting flags, and whether it runs in the background for `start`. */
export interface RunOptions {
  dataDir: string
  flags: Partial<Record<SettingFlag, string>>
  background: boolean
}

/**
 * `corch run`: takes the data folder's lock, then loads the settings and starts the host on 127.0.0.1, and writes
 * the run file once it listens. SIGTERM and SIGINT remove both files. In the background its output goes to
 * `corch.log`; in the foreground to the terminal. Answers an exit code when it can't run, and null while the host
 * runs. A data folder that isn't this user's own is refused first.
 */
export async function run({ dataDir, flags, background }: RunOptions): Promise<number | null> {
  const refused = ensureDataFolder(dataDir)
  if (refused) {
    console.error(refused)
    return 1
  }
  if (background) captureConsole(new CappedLog(logPath(dataDir)))

  const lock: LockRecord = { pid: process.pid, instanceId: randomUUID(), startedAt: Date.now() }
  if (!(await takeLock(dataDir, lock))) return LOCK_HELD_EXIT
  const release = () => removeProcessFiles(dataDir, lock.instanceId)

  let settings: Settings
  try {
    migrateRemoteAccessAddresses(dataDir)
    settings = loadSettings({ flags, env: process.env, file: readSettingsFile(settingsPath(dataDir)) })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    release()
    return 1
  }

  const build = embeddedBuildId()
  if (build === null) throw new Error('corch run needs a build id compiled in')
  try {
    startHost({
      dataDir,
      projectRoot: homedir(),
      settings,
      daemonRuntime: daemonRuntimeDir(dataDir, process.getuid?.() ?? 'user'),
      daemonCommand: daemonCommand({ packaged: true, self: selfCommand(), dev: [] }),
      build,
      ui: await packagedUi(),
      packaged: true,
      // `SERVER_URL` and `CLIENT_URL` are dev-only: the packaged host takes its addresses from its settings.
      addresses: {},
      hostname: '127.0.0.1',
      port: settings.port.value,
      instanceId: lock.instanceId,
      onListening: ({ url }) => writeRunFile(dataDir, { ...lock, url }),
      onShutdown: release,
    })
  } catch (error) {
    console.error(`corch could not start: ${error instanceof Error ? error.message : String(error)}`)
    release()
    return 1
  }
  return null
}

/**
 * Takes the lock, removing a stale one first. False when a host holds it, after saying so; a host that is still
 * starting counts, so two concurrent starts end up with one host.
 */
async function takeLock(dataDir: string, lock: LockRecord): Promise<boolean> {
  for (let tries = 0; tries < 3; tries++) {
    if (acquireLock(dataDir, lock)) return true
    const state = await hostState(dataDir)
    if (state.kind === 'running') {
      console.error(`A host is already running at ${state.run.url} (pid ${state.run.pid})`)
      return false
    }
    if (state.kind === 'starting') {
      console.error(`A host is already starting (pid ${state.pid ?? 'unknown'})`)
      return false
    }
  }
  console.error(`Could not take the lock in ${dataDir}`)
  return false
}

/**
 * The UI to serve: the built `apps/web` compiled into the executable, or none. Run from source nothing is compiled
 * in, so there is none. It never reads a folder on disk.
 */
async function packagedUi(): Promise<UiSite | null> {
  const files = embeddedUi()
  const ui = files ? await loadEmbeddedUiSite(files) : null
  if (!ui) console.log('This host has no local UI; open it from the client app')
  return ui
}
