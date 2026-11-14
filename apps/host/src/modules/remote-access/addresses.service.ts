import type { RemoteAccessStatus, UpdateRemoteAccessBody } from '@orch/shared'
import { clientUrlFromServerUrl, parseClientUrl } from '../access/access.service'
import { readSettingsFile, saveAddresses } from '../settings/settings.repository'
import { DEFAULT_SERVER_URL, derivedClientUrl, type Setting, type Settings } from '../settings/settings.service'
import { parseServerUrl } from '../tunnel/tunnel.service'
import { InvalidRemoteAccessSetting } from './remote-access.errors'

/** The dev host's environment variables that override the saved addresses. Empty values count as unset. */
export interface RemoteAccessEnv {
  SERVER_URL?: string
  CLIENT_URL?: string
}

/**
 * The relay and client addresses in use, as loaded at start. The client
 * address is null only when it is derived from a relay address that is not a
 * `ws(s)://` one, which only `SERVER_URL` can set.
 */
export interface RemoteAddresses {
  relayUrl: Setting<string>
  clientUrl: Setting<string | null>
}

/**
 * The dev host's addresses: `SERVER_URL` and `CLIENT_URL` on top of the loaded
 * settings, set by those names. An invalid `SERVER_URL` is kept, so the host
 * runs without a tunnel and says why; an invalid `CLIENT_URL` is logged with
 * `log` and ignored. A derived client address follows `SERVER_URL`.
 */
export function devAddresses(
  settings: Pick<Settings, 'relayUrl' | 'clientUrl'>,
  env: RemoteAccessEnv,
  log: (line: string) => void = console.error,
): RemoteAddresses {
  const server = env.SERVER_URL || undefined
  const relayUrl: Setting<string> = server ? { value: server, source: 'env', setBy: 'SERVER_URL' } : settings.relayUrl
  const client = env.CLIENT_URL || undefined
  if (client && parseClientUrl(client)) {
    return { relayUrl, clientUrl: { value: client, source: 'env', setBy: 'CLIENT_URL' } }
  }
  if (client) log('CLIENT_URL must be an http:// or https:// URL. Ignoring it')
  if (!server || settings.clientUrl.source !== 'derived') return { relayUrl, clientUrl: settings.clientUrl }
  return {
    relayUrl,
    clientUrl: parseServerUrl(server)
      ? derivedClientUrl(server)
      : { value: clientUrlFromServerUrl(server), source: 'derived', setBy: null },
  }
}

/**
 * The server address to save from what the user entered: trimmed, or null when
 * empty, which means the default. Throws `InvalidRemoteAccessSetting` for an
 * address `parseServerUrl` refuses.
 */
export function enteredServerUrl(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed && !parseServerUrl(trimmed)) {
    throw new InvalidRemoteAccessSetting(
      'The server address must be wss://<host>, or ws:// on 127.0.0.1, [::1] or localhost',
    )
  }
  return trimmed || null
}

/** The client address connect links are built on, from the one in use, without a trailing slash. Null when there is none. */
export function linkClientUrl(clientUrl: Setting<string | null>): string | null {
  return clientUrl.value === null ? null : parseClientUrl(clientUrl.value)
}

/** The addresses saved in the settings file. Null means none is saved there. */
interface FileAddresses {
  relayUrl: string | null
  clientUrl: string | null
}

/** The part of the remote access status about addresses. */
type AddressStatus = Pick<
  RemoteAccessStatus,
  | 'serverUrl'
  | 'serverUrlIsDefault'
  | 'clientUrl'
  | 'serverUrlSetBy'
  | 'clientUrlSetBy'
  | 'savedServerUrl'
  | 'savedClientUrl'
  | 'restartNeeded'
>

/**
 * The relay and client addresses of a running host: the ones in use, fixed at
 * start, and the ones saved in the settings file, which the host uses from its
 * next start. An address a flag or the environment sets is never saved.
 */
export class RemoteAccessAddresses {
  private saved: FileAddresses = { relayUrl: null, clientUrl: null }

  constructor(
    readonly inUse: RemoteAddresses,
    private readonly file: string,
    private readonly defaultServerUrl = DEFAULT_SERVER_URL,
  ) {}

  /** Reads the saved addresses. A file that can't be read is logged, and counts as saving none. */
  load() {
    try {
      const file = readSettingsFile(this.file)
      const text = (value: unknown) => (typeof value === 'string' ? value : null)
      this.saved = { relayUrl: text(file?.relayUrl), clientUrl: text(file?.clientUrl) }
    } catch (error) {
      console.error(`the saved addresses are unknown: ${error instanceof Error ? error.message : 'unreadable'}`)
    }
  }

  /** The tunnel URL of the server address in use. Null when it is not valid, which only `SERVER_URL` can cause. */
  tunnelUrl(): string | null {
    return parseServerUrl(this.inUse.relayUrl.value)
  }

  /** True when the address in use is the default's, compared as tunnel URLs. */
  isDefault(): boolean {
    const inUse = this.tunnelUrl()
    return inUse !== null && inUse === parseServerUrl(this.defaultServerUrl)
  }

  status(): AddressStatus {
    const { relayUrl, clientUrl } = this.inUse
    return {
      serverUrl: relayUrl.value,
      serverUrlIsDefault: this.isDefault(),
      clientUrl: clientUrl.source === 'derived' ? null : clientUrl.value,
      serverUrlSetBy: relayUrl.setBy,
      clientUrlSetBy: clientUrl.setBy,
      savedServerUrl: this.saved.relayUrl,
      savedClientUrl: this.saved.clientUrl,
      restartNeeded: this.restartNeeded(),
    }
  }

  /**
   * Saves the entered addresses that no flag or variable sets to the settings
   * file, keeping its other keys. Throws `InvalidRemoteAccessSetting` for an
   * address the host refuses, or a settings file it can't rewrite, before
   * anything is saved. With `enabled`, an overridden relay address must be valid.
   */
  save({ enabled, serverUrl, clientUrl }: UpdateRemoteAccessBody) {
    const { relayUrl, clientUrl: client } = this.inUse
    if (relayUrl.setBy && enabled && !this.tunnelUrl()) {
      throw new InvalidRemoteAccessSetting(
        `${relayUrl.setBy} is not a valid server address. Fix it and restart the host`,
      )
    }
    const next = { ...this.saved }
    if (!relayUrl.setBy) next.relayUrl = enteredServerUrl(serverUrl)
    if (!client.setBy) {
      const trimmed = clientUrl?.trim() ?? ''
      next.clientUrl = trimmed ? parseClientUrl(trimmed) : null
      if (trimmed && !next.clientUrl) {
        throw new InvalidRemoteAccessSetting('The client address must be an http:// or https:// URL')
      }
    }
    if (next.relayUrl === this.saved.relayUrl && next.clientUrl === this.saved.clientUrl) return
    try {
      // An overridden address is left out, so the file keeps whatever it holds for it.
      saveAddresses(this.file, {
        ...(relayUrl.setBy ? {} : { relayUrl: next.relayUrl }),
        ...(client.setBy ? {} : { clientUrl: next.clientUrl }),
      })
    } catch (error) {
      throw new InvalidRemoteAccessSetting(
        `The addresses could not be saved: ${error instanceof Error ? error.message : 'unknown error'}`,
      )
    }
    this.saved = next
  }

  /**
   * True when an address saved in the settings file, and set by no flag or
   * environment variable, differs from the one in use, so it applies only once
   * the host restarts.
   */
  private restartNeeded(): boolean {
    const { relayUrl, clientUrl } = this.inUse
    const nextRelay = relayUrl.setBy ? relayUrl.value : (this.saved.relayUrl ?? this.defaultServerUrl)
    if (!relayUrl.setBy && !sameUrl(parseServerUrl, nextRelay, relayUrl.value)) return true
    if (clientUrl.setBy) return false
    const nextClient = this.saved.clientUrl ?? clientUrlFromServerUrl(nextRelay)
    return !sameUrl(parseClientUrl, nextClient, clientUrl.value)
  }
}

/** True when `a` and `b` are the same address once `parse` normalises them, or the same text when it refuses one. */
function sameUrl(parse: (value: string) => string | null, a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b
  return (parse(a) ?? a) === (parse(b) ?? b)
}
