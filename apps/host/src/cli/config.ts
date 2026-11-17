import { routes } from '@orch/shared'
import {
  migrateRemoteAccessAddresses,
  readSettingsFile,
  saveSettings,
  settingsPath,
} from '../modules/settings/settings.repository'
import {
  loadSettings,
  SETTING_ENV,
  SETTING_KEYS,
  type Setting,
  type Settings,
  settingFromText,
  settingKey,
} from '../modules/settings/settings.service'
import { type CallHost, readLinkedAccount } from '../remote-cli'
import { messageOf, printable, refused } from '../remote-cli-output'
import type { ConfigAction } from './args'

// `corch config`: reads and changes the settings in the data folder's `config.json`. A host reads them only when it
// starts, so `set` and `unset` write the file directly even while one runs. They ask a running host, through its
// local-only `routes.remoteAccess.status`, only whether the machine is connected, which fixes its server address.

export interface ConfigDeps {
  /** The data folder, holding `config.json`. */
  dataDir: string
  /** The shell's environment, whose `CORCH_*` variables a host started from it would use. */
  env: Record<string, string | undefined>
  /** Calls the running host. Null means none runs. */
  callHost: CallHost | null
  out: (line: string) => void
  err: (line: string) => void
}

/** Runs one `corch config` subcommand and answers its exit code. Every problem is printed, never thrown. */
export async function runConfig(action: ConfigAction, deps: ConfigDeps): Promise<number> {
  try {
    switch (action.name) {
      case 'path':
        deps.out(settingsPath(deps.dataDir))
        return 0
      case 'list':
        return list(deps)
      case 'get': {
        const key = settingKey(action.key)
        deps.out(printable(String(inEffect(deps)[key].value)))
        return 0
      }
      case 'set':
      case 'unset':
        return await change(action, deps)
    }
  } catch (error) {
    deps.err(messageOf(error))
    return 1
  }
}

/** The settings a host started from this shell would use: its `CORCH_*` variables, then `config.json`, then the defaults. */
function inEffect(deps: ConfigDeps): Settings {
  return loadSettings({ flags: {}, env: deps.env, file: readSettingsFile(settingsPath(deps.dataDir)) })
}

/** Where a setting's value comes from, as `list` shows it. */
function sourceOf(setting: Setting<unknown>): string {
  return setting.source === 'env' && setting.setBy ? `env ${setting.setBy}` : setting.source
}

function list(deps: ConfigDeps): number {
  const settings = inEffect(deps)
  const width = Math.max(...SETTING_KEYS.map((key) => key.length)) + 2
  for (const key of SETTING_KEYS) {
    const setting = settings[key]
    deps.out(`${key.padEnd(width)}${printable(String(setting.value))}  (${sourceOf(setting)})`)
  }
  return 0
}

/**
 * Sets or removes one key in `config.json`, after checking the file and the new
 * value as `loadSettings` would, so nothing is written for a bad one. The server
 * address can't change while the machine is connected to an account, which
 * the running host says, or `linked-account.json` when none runs. With the
 * host stopped, the old remote-access addresses are migrated first. Then it
 * says what the running host and the shell's environment mean for the change.
 */
async function change(action: Extract<ConfigAction, { name: 'set' | 'unset' }>, deps: ConfigDeps): Promise<number> {
  const key = settingKey(action.key)
  const value = action.name === 'set' ? settingFromText(key, action.value) : null
  const path = settingsPath(deps.dataDir)
  // Checked before the migration, which could otherwise write to a file this command then refuses.
  loadSettings({ flags: {}, env: {}, file: readSettingsFile(path) })

  const status = deps.callHost ? await deps.callHost(routes.remoteAccess.status, {}) : null
  if (status && !status.ok) return refused(status, deps.err)
  if (key === 'relayUrl') {
    const account = status ? status.data.linkedAccount : readLinkedAccount(deps.dataDir, deps.err)
    if (account === undefined) return 1
    if (account) {
      deps.err('This machine is connected to an account through its server address. Run corch disconnect first.')
      return 1
    }
  }
  if (!status) migrateRemoteAccessAddresses(deps.dataDir)

  const current = readSettingsFile(path) ?? {}
  if (value === null && !(key in current)) {
    deps.out(`${key} is not set in ${path}`)
    return 0
  }
  saveSettings(path, { [key]: value })
  if (value === null) {
    // The file alone decides this, so a `CORCH_*` variable in this shell doesn't hide the change.
    const { [key]: _, ...rest } = current
    const now = loadSettings({ flags: {}, env: {}, file: rest })[key]
    deps.out(`Removed ${key} from ${path}. It is now ${printable(String(now.value))} (${now.source}).`)
  } else {
    deps.out(`Saved ${key} ${printable(String(value))} in ${path}`)
  }
  const variable = SETTING_ENV[key]
  if (deps.env[variable]) {
    deps.out(`${variable} is set in this shell and overrides it for a host started from here.`)
  }
  if (status) deps.out('The running host uses the change after corch restart.')
  return 0
}
