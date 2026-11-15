import { type RemoteAccessStatus, routes } from '@orch/shared'
import { LinkedAccountRepository, linkedAccountPath } from '../modules/remote-access/linked-account.repository'
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
  type SettingKey,
  type Settings,
  settingFromText,
  settingKey,
} from '../modules/settings/settings.service'
import { parseServerUrl } from '../modules/tunnel/tunnel.service'
import { type CallHost, remoteAccessLine } from '../remote-cli'
import { messageOf, printable, refused } from '../remote-cli-output'
import type { ConfigAction } from './args'

// `corch config`: reads and changes the settings in the data folder's `config.json`. A host reads them only when it
// starts, so `set` and `unset` write the file directly even while one runs; the one thing they ask a running host to
// do is turn remote access off, through its local-only `routes.remoteAccess` endpoints.

export interface ConfigDeps {
  /** The data folder, holding `config.json`. */
  dataDir: string
  /** The shell's environment, whose `CORCH_*` variables a host started from it would use. */
  env: Record<string, string | undefined>
  /** Calls the running host. Null means none runs. */
  callHost: CallHost | null
  /** Asks a question and answers the line typed. Null means the input ended. */
  prompt: (question: string) => Promise<string | null>
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
 * value as `loadSettings` would, so nothing is written for a bad one. With the
 * host stopped, the old remote-access addresses are migrated first, as
 * `corch remote server` does. Then it says what the running host, the shell's
 * environment and a linked account mean for the change.
 */
async function change(action: Extract<ConfigAction, { name: 'set' | 'unset' }>, deps: ConfigDeps): Promise<number> {
  const key = settingKey(action.key)
  const value = action.name === 'set' ? settingFromText(key, action.value) : null
  const path = settingsPath(deps.dataDir)
  // Checked before the migration, which could otherwise write to a file this command then refuses.
  loadSettings({ flags: {}, env: {}, file: readSettingsFile(path) })

  const status = deps.callHost ? await deps.callHost(routes.remoteAccess.status, {}) : null
  if (status && !status.ok) return refused(status, deps.err)
  if (!status) migrateRemoteAccessAddresses(deps.dataDir)

  const current = readSettingsFile(path) ?? {}
  const next = { ...current }
  if (value === null) delete next[key]
  else next[key] = value
  // The file alone decides these, so a `CORCH_*` variable in this shell doesn't hide a change.
  const before = loadSettings({ flags: {}, env: {}, file: current })
  const after = loadSettings({ flags: {}, env: {}, file: next })

  if (value === null && !(key in current)) {
    deps.out(`${key} is not set in ${path}`)
    return 0
  }
  saveSettings(path, { [key]: value })
  if (value === null) {
    const now = after[key]
    deps.out(`Removed ${key} from ${path}. It is now ${printable(String(now.value))} (${now.source}).`)
  } else {
    deps.out(`Saved ${key} ${printable(String(value))} in ${path}`)
  }
  const variable = SETTING_ENV[key]
  if (deps.env[variable]) {
    deps.out(`${variable} is set in this shell and overrides it for a host started from here.`)
  }
  if (status) deps.out('The running host uses the change after corch restart.')

  if (sameRelay(before.relayUrl.value, after.relayUrl.value)) return 0
  warnAboutLink(after.relayUrl.value, deps)
  if (!status) return 0
  return offerRemoteOff(status.data, next, after.relayUrl.value, action.yes, deps)
}

function sameRelay(a: string, b: string): boolean {
  return (parseServerUrl(a) ?? a) === (parseServerUrl(b) ?? b)
}

/** Warns that an account linked through another server than `relayUrl` stays linked to that one. */
function warnAboutLink(relayUrl: string, deps: ConfigDeps) {
  let account: ReturnType<LinkedAccountRepository['load']>
  try {
    account = new LinkedAccountRepository(linkedAccountPath(deps.dataDir)).load()
  } catch (error) {
    deps.err(messageOf(error))
    return
  }
  if (!account || sameRelay(account.serverUrl, relayUrl)) return
  deps.out(
    `Warning: this machine is linked to an account through ${printable(account.serverUrl)}. That link belongs to ` +
      'the old server: run corch remote unlink, then link again with a key from the new one.',
  )
}

/**
 * Offers to turn remote access off when the running host's tunnel is open to
 * another relay than `nextRelay`, the one it would use after a restart, since it stays connected there until
 * `corch restart`. It turns off with `yes`, or a `y` typed at the question,
 * through the host's `update`, sending the saved addresses so the call keeps them.
 */
async function offerRemoteOff(
  current: RemoteAccessStatus,
  saved: Partial<Record<SettingKey, unknown>>,
  nextRelay: string,
  yes: boolean,
  deps: ConfigDeps,
): Promise<number> {
  // A flag or variable that sets the host's relay keeps it there after a restart too.
  if (!current.enabled || current.serverUrlSetBy) return 0
  if (sameRelay(nextRelay, current.serverUrl)) return 0
  deps.out(`The open tunnel stays connected to ${printable(current.serverUrl)} until corch restart.`)
  if (!yes) {
    const answer = await deps.prompt('Turn remote access off now? [y/N] ')
    if (!/^(y|yes)$/i.test(answer?.trim() ?? '')) {
      deps.out('Remote access stays on.')
      return 0
    }
  }
  const answer = await (deps.callHost as CallHost)(routes.remoteAccess.update, {
    enabled: false,
    serverUrl: typeof saved.relayUrl === 'string' ? saved.relayUrl : '',
    clientUrl: typeof saved.clientUrl === 'string' ? saved.clientUrl : null,
  })
  if (!answer?.ok) return refused(answer, deps.err)
  deps.out(remoteAccessLine(answer.data.enabled, answer.data.tunnel))
  return 0
}
