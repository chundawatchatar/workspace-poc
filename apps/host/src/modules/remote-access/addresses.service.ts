import { parseServerUrl, type RemoteAccessStatus, sameServerUrl } from '@orch/shared'
import { saveAddresses } from '../settings/settings.repository'
import { DEFAULT_SERVER_URL, type Setting, type Settings } from '../settings/settings.service'
import { InvalidRemoteAccessSetting } from './remote-access.errors'

/** The dev host's environment variable that overrides the saved server address. An empty value counts as unset. */
export interface RemoteAccessEnv {
  SERVER_URL?: string
}

/** The relay address in use. */
export interface RemoteAddresses {
  relayUrl: Setting<string>
}

/**
 * The dev host's addresses: `SERVER_URL` on top of the loaded settings, set by
 * that name. An invalid `SERVER_URL` is kept, so the host runs without a
 * tunnel and says why.
 */
export function devAddresses(settings: Pick<Settings, 'relayUrl'>, env: RemoteAccessEnv): RemoteAddresses {
  const server = env.SERVER_URL || undefined
  return { relayUrl: server ? { value: server, source: 'env', setBy: 'SERVER_URL' } : settings.relayUrl }
}

/** What the host says about a server address it refuses. It never quotes the address. */
export const SERVER_URL_RULE = 'The server address must be wss://<host>, or ws:// on 127.0.0.1, [::1] or localhost'

/** The part of the remote access status about addresses. */
type AddressStatus = Pick<
  RemoteAccessStatus,
  'serverUrl' | 'serverUrlIsDefault' | 'defaultServerUrl' | 'serverUrlSetBy'
>

/**
 * The relay address of a running host: the one it started with, until Connect
 * makes another server address the one in use and saves it in the settings
 * file. An address a flag or the environment sets is never changed or saved.
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
    const { relayUrl } = this.current
    return {
      serverUrl: relayUrl.value,
      serverUrlIsDefault: this.isDefault(),
      defaultServerUrl: this.defaultServerUrl,
      serverUrlSetBy: relayUrl.setBy,
    }
  }

  /**
   * Makes `serverUrl`, a valid address, the server address in use, and saves
   * it as `relayUrl` in the settings file, keeping the file's other keys. The
   * default is saved as no address at all, so a later default applies. An
   * address a flag or variable sets is left as it is. Throws `InvalidRemoteAccessSetting` when the settings file
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
    this.current = {
      relayUrl: isDefault
        ? { value: this.defaultServerUrl, source: 'default', setBy: null }
        : { value: serverUrl, source: 'file', setBy: null },
    }
  }
}
