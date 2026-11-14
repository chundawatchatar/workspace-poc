import { z } from 'zod'
import { clientUrlFromServerUrl, parseClientUrl } from '../access/access.service'
import { parseServerUrl } from '../tunnel/tunnel.service'

/**
 * The server address used when nothing sets one. `orch.example.com` is a
 * reserved placeholder: replace it with the real server's address before launch.
 */
export const DEFAULT_SERVER_URL = 'wss://orch.example.com'

/** The name of the settings file in the data folder, as error messages show it. */
export const SETTINGS_FILE_NAME = 'config.json'

export const LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

/** A setting that can't be used, or a settings file that can't be read. Its message names the setting and where it came from. */
export class SettingsError extends Error {}

/** Where a setting's value came from. `derived` is a client address worked out from the relay address in use. */
export type SettingSource = 'flag' | 'env' | 'file' | 'default' | 'derived'

/** A resolved setting. `setBy` is the flag or environment variable that set it, and null for any other source. */
export interface Setting<T> {
  value: T
  source: SettingSource
  setBy: string | null
}

/** The host's settings, each resolved on its own. */
export interface Settings {
  port: Setting<number>
  relayUrl: Setting<string>
  clientUrl: Setting<string>
  logLevel: Setting<LogLevel>
}

/** The values used when no flag, environment variable or file sets a setting. The client address is derived instead. */
export interface SettingsDefaults {
  port: number
  relayUrl: string
  logLevel: LogLevel
}

export const SETTINGS_DEFAULTS: SettingsDefaults = { port: 4599, relayUrl: DEFAULT_SERVER_URL, logLevel: 'info' }

/** The flag that sets each setting. */
export const SETTING_FLAGS = {
  port: '--port',
  relayUrl: '--relay-url',
  clientUrl: '--client-url',
  logLevel: '--log-level',
} as const

/** The environment variable that sets each setting. */
export const SETTING_ENV = {
  port: 'CORCH_PORT',
  relayUrl: 'CORCH_RELAY_URL',
  clientUrl: 'CORCH_CLIENT_URL',
  logLevel: 'CORCH_LOG_LEVEL',
} as const

type Key = keyof Settings
export type SettingFlag = (typeof SETTING_FLAGS)[Key]

export interface SettingsInput {
  /** The flags given, by name (`--port`), as strings. */
  flags: Partial<Record<SettingFlag, string>>
  /** The environment to read the `CORCH_*` variables from. */
  env: Record<string, string | undefined>
  /** The parsed settings file, or null when there is none. */
  file: unknown
  defaults?: SettingsDefaults
}

const RULES: Record<Key, string> = {
  port: 'must be a whole number from 1 to 65535',
  relayUrl: 'must be wss://<host>, or ws:// on 127.0.0.1, [::1] or localhost',
  clientUrl: 'must be an http:// or https:// URL',
  logLevel: `must be one of ${LOG_LEVELS.join(', ')}`,
}

const portNumber = z.number().int().min(1).max(65535)
const relayUrl = z.string().refine((value) => parseServerUrl(value) !== null)
const clientUrl = z.string().refine((value) => parseClientUrl(value) !== null)
const logLevel = z.enum(LOG_LEVELS)

/** Each setting as a flag or an environment variable gives it: a string. */
const fromText = {
  port: z.string().regex(/^\d+$/).transform(Number).pipe(portNumber),
  relayUrl,
  clientUrl,
  logLevel,
}

/** The settings file: a JSON object holding only known settings, each optional. */
export const settingsFile = z.strictObject({
  port: portNumber.optional(),
  relayUrl: relayUrl.optional(),
  clientUrl: clientUrl.optional(),
  logLevel: logLevel.optional(),
})
export type SettingsFile = z.infer<typeof settingsFile>

const KEYS = Object.keys(RULES) as Key[]

/**
 * Resolves each setting on its own: its flag, else its `CORCH_<NAME>`
 * variable, else the settings file, else the default. An empty flag or
 * variable counts as unset. A client address set nowhere is derived from the
 * relay address that won. Throws `SettingsError` for a bad value or an unknown
 * key in the file, naming the key and where it came from.
 */
export function loadSettings({ flags, env, file, defaults = SETTINGS_DEFAULTS }: SettingsInput): Settings {
  const saved = parseFile(file)
  function resolve<K extends Key>(key: K): Setting<z.output<(typeof fromText)[K]>> | null {
    for (const [source, name, value] of [
      ['flag', SETTING_FLAGS[key], flags[SETTING_FLAGS[key]]],
      ['env', SETTING_ENV[key], env[SETTING_ENV[key]]],
    ] as const) {
      if (!value) continue
      const parsed = fromText[key].safeParse(value)
      if (!parsed.success) throw new SettingsError(`${name} (${key}) ${RULES[key]}`)
      return { value: parsed.data as z.output<(typeof fromText)[K]>, source, setBy: name }
    }
    const value = saved[key]
    return value === undefined ? null : { value: value as z.output<(typeof fromText)[K]>, source: 'file', setBy: null }
  }
  const relay = resolve('relayUrl') ?? { value: defaults.relayUrl, source: 'default', setBy: null }
  return {
    port: resolve('port') ?? { value: defaults.port, source: 'default', setBy: null },
    relayUrl: relay,
    clientUrl: resolve('clientUrl') ?? derivedClientUrl(relay.value),
    logLevel: resolve('logLevel') ?? { value: defaults.logLevel, source: 'default', setBy: null },
  }
}

/**
 * The client address derived from a relay address: `wss:` becomes `https:` and
 * `ws:` becomes `http:`. Throws `SettingsError` for an address that is not
 * `ws(s)://`, which a resolved relay address never is.
 */
export function derivedClientUrl(relay: string): Setting<string> {
  const value = clientUrlFromServerUrl(relay)
  if (value === null) throw new SettingsError(`relayUrl ${RULES.relayUrl}`)
  return { value, source: 'derived', setBy: null }
}

/** The file's settings, checked against `settingsFile`. Null means no file, so nothing is set there. */
function parseFile(file: unknown): SettingsFile {
  if (file === null || file === undefined) return {}
  if (typeof file !== 'object' || Array.isArray(file)) {
    throw new SettingsError(`${SETTINGS_FILE_NAME} must hold a JSON object of settings`)
  }
  const parsed = settingsFile.safeParse(file)
  if (parsed.success) return parsed.data
  const [issue] = parsed.error.issues
  if (issue?.code === 'unrecognized_keys') {
    throw new SettingsError(
      `${SETTINGS_FILE_NAME}: ${issue.keys.join(', ')} is not a setting. The settings are ${KEYS.join(', ')}`,
    )
  }
  const key = issue?.path[0] as Key
  throw new SettingsError(`${SETTINGS_FILE_NAME}: ${key} ${RULES[key]}`)
}
