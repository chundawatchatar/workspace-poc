import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RemoteAccessRepository, remoteAccessPath, writeJsonAtomic } from '../remote-access/remote-access.repository'
import { SETTINGS_FILE_NAME, SettingsError } from './settings.service'

/** Where the host's settings are kept. */
export function settingsPath(dataDir: string) {
  return join(dataDir, SETTINGS_FILE_NAME)
}

/**
 * The settings file as a JSON object, or null when it does not exist. Throws
 * `SettingsError` naming the file when it is not JSON or not an object; its
 * keys and values are checked by `loadSettings`.
 */
export function readSettingsFile(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new SettingsError(`${path} is not valid JSON. Fix the file, or delete it to use the defaults`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SettingsError(
      `${path} must hold a JSON object of settings. Fix the file, or delete it to use the defaults`,
    )
  }
  return value as Record<string, unknown>
}

/** The addresses to change. A string sets the key, null removes it, and a key left out keeps its value. */
export interface SavedAddresses {
  relayUrl?: string | null
  clientUrl?: string | null
}

/**
 * Rereads the settings file and sets or removes only the addresses named, so
 * every other key stays as it is. Throws, writing nothing, when the file is not
 * valid. The file is replaced in one step, so a crash never leaves half of it.
 */
export function saveAddresses(path: string, addresses: SavedAddresses) {
  const next = { ...readSettingsFile(path) }
  for (const key of ['relayUrl', 'clientUrl'] as const) {
    const value = addresses[key]
    if (value === undefined) continue
    if (value === null) delete next[key]
    else next[key] = value
  }
  writeJsonAtomic(path, next)
}

/**
 * Moves the addresses a folder from before `config.json` keeps in
 * `remote-access.json` into the settings file, once. Each old address is
 * copied as it is, valid or not, only when the settings file has no value for
 * it; then `remote-access.json` is rewritten with only its flag. The settings
 * file is written first, so a run cut short between the two steps is finished
 * by the next one. Throws, writing nothing, when either file is not valid.
 * True when it migrated.
 */
export function migrateRemoteAccessAddresses(dataDir: string): boolean {
  const remote = new RemoteAccessRepository(remoteAccessPath(dataDir))
  const old = remote.load()
  if (!old || (old.serverUrl === undefined && old.clientUrl === undefined)) return false
  const path = settingsPath(dataDir)
  const current = readSettingsFile(path)
  const copied: SavedAddresses = {}
  if (old.serverUrl != null && current?.relayUrl === undefined) copied.relayUrl = old.serverUrl
  if (old.clientUrl != null && current?.clientUrl === undefined) copied.clientUrl = old.clientUrl
  if (Object.keys(copied).length > 0) saveAddresses(path, copied)
  remote.save({ enabled: old.enabled })
  return true
}
