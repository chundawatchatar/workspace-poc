import { parseServerUrl, type RemoteAccessStatus, sameServerUrl } from '@orch/shared'
import { clientUrlFromServerUrl, parseClientUrl } from '../access/access.service'
import { saveAddresses } from '../settings/settings.repository'
import { DEFAULT_SERVER_URL, derivedClientUrl, type Setting, type Settings } from '../settings/settings.service'
import { InvalidRemoteAccessSetting } from './remote-access.errors'

/** The dev host's environment variables that override the saved addresses. Empty values count as unset. */
export interface RemoteAccessEnv {
  SERVER_URL?: string
  CLIENT_URL?: string
}

/**
 * The relay and client addresses in use. The client address is null only when
 * it is derived from a relay address that is not a `ws(s)://` one, which only
 * `SERVER_URL` can set.
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

/** What the host says about a server address it refuses. It never quotes the address. */
export const SERVER_URL_RULE = 'The server address must be wss://<host>, or ws:// on 127.0.0.1, [::1] or localhost'

/**
 * A server address the user entered, trimmed. Throws `InvalidRemoteAccessSetting`
 * for an empty one or one `parseServerUrl` refuses.
 */
export function enteredServerUrl(value: string): string {
  const trimmed = value.trim()
  if (!parseServerUrl(trimmed)) throw new InvalidRemoteAccessSetting(SERVER_URL_RULE)
  return trimmed
}

/** The client address connect links are built on, from the one in use, without a trailing slash. Null when there is none. */
export function linkClientUrl(clientUrl: Setting<string | null>): string | null {
  return clientUrl.value === null ? null : parseClientUrl(clientUrl.value)
}

/** The part of the remote access status about addresses. */
type AddressStatus = Pick<
  RemoteAccessStatus,
  'serverUrl' | 'serverUrlIsDefault' | 'defaultServerUrl' | 'clientUrl' | 'serverUrlSetBy' | 'clientUrlSetBy'
>

/**
 * The relay and client addresses of a running host: the ones it started with,
 * until Connect makes another server address the one in use and saves it in
 * the settings file. An address a flag or the environment sets is never
 * changed or saved.
 */
export class RemoteAccessAddresses {
  private current: RemoteAddresses

  constructor(
    inUse: RemoteAddresses,
    private readonly file: string,
    private readonly defaultServerUrl = DEFAULT_SERVER_URL,
  ) {
    this.current = inUse
  }

  /** The addresses in use. */
  get inUse(): RemoteAddresses {
    return this.current
  }

  /** The tunnel URL of the server address in use. Null when it is not valid, which only `SERVER_URL` can cause. */
  tunnelUrl(): string | null {
    return parseServerUrl(this.current.relayUrl.value)
  }

  /** True when the address in use is the default's, compared as tunnel URLs. */
  isDefault(): boolean {
    return sameServerUrl(this.current.relayUrl.value, this.defaultServerUrl)
  }

  status(): AddressStatus {
    const { relayUrl, clientUrl } = this.current
    return {
      serverUrl: relayUrl.value,
      serverUrlIsDefault: this.isDefault(),
      defaultServerUrl: this.defaultServerUrl,
      clientUrl: clientUrl.source === 'derived' ? null : clientUrl.value,
      serverUrlSetBy: relayUrl.setBy,
      clientUrlSetBy: clientUrl.setBy,
    }
  }

  /**
   * Makes `serverUrl`, a valid address, the server address in use, and saves
   * it as `relayUrl` in the settings file, keeping the file's other keys. The
   * default is saved as no address at all, so a later default applies. A
   * derived client address follows it. An address a flag or variable sets is
   * left as it is. Throws `InvalidRemoteAccessSetting` when the settings file
   * can't be rewritten, before anything changes.
   */
  use(serverUrl: string) {
    if (this.current.relayUrl.setBy) return
    const isDefault = sameServerUrl(serverUrl, this.defaultServerUrl)
    try {
      saveAddresses(this.file, { relayUrl: isDefault ? null : serverUrl })
    } catch (error) {
      throw new InvalidRemoteAccessSetting(
        `The server address could not be saved: ${error instanceof Error ? error.message : 'unknown error'}`,
      )
    }
    const relayUrl: Setting<string> = isDefault
      ? { value: this.defaultServerUrl, source: 'default', setBy: null }
      : { value: serverUrl, source: 'file', setBy: null }
    const { clientUrl } = this.current
    this.current = {
      relayUrl,
      clientUrl: clientUrl.source === 'derived' ? derivedClientUrl(relayUrl.value) : clientUrl,
    }
  }
}
