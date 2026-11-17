import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RemoteAccessRepository, remoteAccessPath, writeJsonAtomic } from '../remote-access/remote-access.repository'
import { SETTINGS_FILE_NAME, SettingsError, type SettingsFile } from './settings.service'

/** Where the host's settings are kept. */
export function settingsPath(dataDir: string) {
  return join(dataDir, SETTINGS_FILE_NAME)
}

/**
 * A key older hosts kept in the settings file and no host reads now. It is
 * dropped when the file is read, so a folder that still has it keeps starting,
 * and the next save removes it from the file.
 */
const RETIRED_KEYS = ['clientUrl']

/**
 * The settings file as a JSON object without its retired keys, or null when it
 * does not exist. Throws `SettingsError` naming the file when it is not JSON or
 * not an object; its keys and values are checked by `loadSettings`.
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
  const settings = { ...value } as Record<string, unknown>
  for (const key of RETIRED_KEYS) delete settings[key]
  return settings
}

/** The addresses to change. A string sets the key, null removes it, and a key left out keeps its value. */
export interface SavedAddresses {
  relayUrl?: string | null
}

/** The settings to change. A value sets the key, null removes it, and a key left out keeps its value. */
export type SettingsChanges = { [K in keyof SettingsFile]?: SettingsFile[K] | null }

/**
 * Rereads the settings file and sets or removes only the keys named, so every
 * other key stays as it is. Throws, writing nothing, when the file is not JSON
 * or not an object; the values are not checked here. The file is replaced in
 * one step, so a crash never leaves half of it.
 */
export function saveSettings(path: string, changes: SettingsChanges) {
  const next = { ...readSettingsFile(path) }
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) continue
    if (value === null) delete next[key]
    else next[key] = value
  }
  writeJsonAtomic(path, next)
}

/** Sets or removes only the addresses named, keeping every other key, as `saveSettings` does. */
export function saveAddresses(path: string, addresses: SavedAddresses) {
  saveSettings(path, { relayUrl: addresses.relayUrl })
}

/**
 * Moves the server address a folder from before `config.json` keeps in
 * `remote-access.json` into the settings file as `relayUrl`, once. It is
 * copied as it is, valid or not, only when the settings file has no value for
 * it; then `remote-access.json` is rewritten with only its flag. The settings
 * file is written first, so a run cut short between the two steps is finished
 * by the next one. Throws, writing nothing, when either file is not valid.
 * True when it migrated.
 */
export function migrateRemoteAccessAddresses(dataDir: string): boolean {
  const remote = new RemoteAccessRepository(remoteAccessPath(dataDir))
  const old = remote.load()
  if (old?.serverUrl === undefined) return false
  const path = settingsPath(dataDir)
  const current = readSettingsFile(path)
  if (old.serverUrl !== null && current?.relayUrl === undefined) saveAddresses(path, { relayUrl: old.serverUrl })
  remote.save({ enabled: old.enabled })
  return true
}
