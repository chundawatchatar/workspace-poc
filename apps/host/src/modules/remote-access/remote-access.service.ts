import { existsSync } from 'node:fs'
import type { RemoteAccessStatus, UpdateRemoteAccessBody } from '@orch/shared'
import { AccessKeyRepository } from '../access/access.repository'
import {
  AccessKeys,
  clientUrlFromServerUrl,
  connectLink,
  DEFAULT_KEY_NAME,
  machineIdFromSecret,
  parseClientUrl,
  type RemoteAccess,
} from '../access/access.service'
import { loadOrCreateMachineSecret } from '../tunnel/tunnel.repository'
import { parseServerUrl, TunnelClient, type TunnelClientOptions } from '../tunnel/tunnel.service'
import type { OpenSocket } from '../tunnel/tunnel-channels.service'
import type { TunnelHandler } from '../tunnel/tunnel-http.service'
import type { RemoteAccessRepository, RemoteAccessSettings } from './remote-access.repository'

/** The environment variables that override the saved setting. Empty values count as unset. */
export interface RemoteAccessEnv {
  SERVER_URL?: string
  CLIENT_URL?: string
}

/** The parts of a `TunnelClient` the service drives. */
export type Tunnel = Pick<TunnelClient, 'start' | 'stop' | 'closeChannels' | 'status'>

export interface RemoteAccessServiceOptions {
  repository: RemoteAccessRepository
  /** The machine secret file, created the first time remote access is needed. */
  secretFile: string
  /** The access keys file. */
  keysFile: string
  env?: RemoteAccessEnv
  /** Answers each tunneled request. Read only once a tunnel is open, so it may close over the app built later. */
  handle: TunnelHandler
  /** Opens each tunneled WebSocket. Read only once a tunnel is open, like `handle`. */
  openSocket: OpenSocket
  /** Builds the tunnel. Defaults to a real `TunnelClient`; tests pass a fake so they need no network. */
  createTunnel?: (options: TunnelClientOptions) => Tunnel
}

/** A setting the host refuses, such as a server address `parseServerUrl` rejects. Its message is meant for the user. */
export class InvalidRemoteAccessSetting extends Error {}

/**
 * The client address connect links are built on: `CLIENT_URL` if it is valid,
 * else the saved client address, else the one derived from the server address
 * in use (`SERVER_URL`, else the saved one). Null when none of them is known.
 */
export function linkClientUrl(env: RemoteAccessEnv, saved: RemoteAccessSettings | null): string | null {
  const fromEnv = env.CLIENT_URL ? parseClientUrl(env.CLIENT_URL) : null
  if (fromEnv) return fromEnv
  if (saved?.clientUrl) return saved.clientUrl
  const serverUrl = env.SERVER_URL || saved?.serverUrl
  return serverUrl ? clientUrlFromServerUrl(serverUrl) : null
}

/**
 * Owns remote access while the host runs: the saved setting, the machine
 * secret, the access keys and the tunnel. `SERVER_URL` and `CLIENT_URL`
 * override the saved addresses, and `SERVER_URL` turns the tunnel on at start
 * whatever the saved flag says. Nothing is read from disk until `start()`.
 */
export class RemoteAccessService {
  private readonly env: RemoteAccessEnv
  private saved: RemoteAccessSettings | null = null
  private secret: string | null = null
  private keys: AccessKeys | null = null
  private tunnel: Tunnel | null = null
  /** The tunnel URL `tunnel` dials, so an update to the same address keeps it. */
  private tunnelUrl: string | null = null

  constructor(private readonly options: RemoteAccessServiceOptions) {
    this.env = { SERVER_URL: options.env?.SERVER_URL || undefined, CLIENT_URL: options.env?.CLIENT_URL || undefined }
  }

  /**
   * Reads the saved setting and opens the tunnel when `SERVER_URL` is set or
   * the setting is on. Any problem is logged and leaves the host local only;
   * a setting file that is not valid is left as it is.
   */
  start() {
    try {
      this.saved = this.options.repository.load()
    } catch (error) {
      console.error(`remote access is off: ${error instanceof Error ? error.message : 'its setting could not be read'}`)
    }
    if (this.env.CLIENT_URL && !parseClientUrl(this.env.CLIENT_URL)) {
      console.error('CLIENT_URL must be an http:// or https:// URL. Ignoring it')
    }
    if (this.env.SERVER_URL) {
      if (!parseServerUrl(this.env.SERVER_URL)) {
        console.error(
          'SERVER_URL must be wss://<host>, or ws:// on 127.0.0.1, [::1] or localhost. Running without a tunnel',
        )
        return
      }
    } else if (!this.saved?.enabled) {
      return
    }
    if (!this.serverTunnelUrl()) {
      console.error('remote access is off: the saved server address is not valid. Enter it again in the setting')
      return
    }
    const keys = this.loadKeys()
    if (keys && keys.size > 0) {
      console.log('remote access is on. Lost the connect link? Run `bun run host:rotate-key` for a new one')
    }
    try {
      this.connect()
    } catch (error) {
      console.error(`no tunnel: ${error instanceof Error ? error.message : 'remote access could not start'}`)
    }
  }

  /** The setting in use and where the tunnel stands. It never holds the machine secret, a key or a hash. */
  status(): RemoteAccessStatus {
    return {
      enabled: this.tunnel !== null,
      serverUrl: this.serverUrl(),
      clientUrl: this.env.CLIENT_URL ?? this.saved?.clientUrl ?? null,
      serverUrlFromEnv: this.env.SERVER_URL !== undefined,
      clientUrlFromEnv: this.env.CLIENT_URL !== undefined,
      machineId: this.machineId(),
      tunnel: this.tunnel?.status ?? 'off',
    }
  }

  /**
   * Saves the setting, then opens, moves or closes the tunnel to match. An
   * address set by `SERVER_URL` or `CLIENT_URL` keeps the saved one as it was.
   * Throws `InvalidRemoteAccessSetting` for an address the host refuses, before
   * anything is saved or the tunnel changes.
   */
  update(input: UpdateRemoteAccessBody): RemoteAccessStatus {
    const next = this.validate(input)
    this.options.repository.save(next)
    this.saved = next
    if (next.enabled) this.connect()
    else this.disconnect()
    return this.status()
  }

  /**
   * What rotating the key needs, or null when no valid server address is known
   * at all. The client address follows the setting as it is now.
   */
  current(): RemoteAccess | null {
    if (!this.serverTunnelUrl()) return null
    const keys = this.loadKeys()
    const machineId = this.machineId()
    if (!keys || !machineId) return null
    return { keys, machineId, clientUrl: linkClientUrl(this.env, this.saved) }
  }

  /** Closes the tunnel and writes pending key use, for shutdown. */
  shutdown() {
    this.disconnect()
    this.keys?.flush()
  }

  private validate({ enabled, serverUrl, clientUrl }: UpdateRemoteAccessBody): RemoteAccessSettings {
    let savedServer = this.saved?.serverUrl ?? null
    if (this.env.SERVER_URL) {
      if (enabled && !parseServerUrl(this.env.SERVER_URL)) {
        throw new InvalidRemoteAccessSetting('SERVER_URL is not a valid server address. Fix it and restart the host')
      }
    } else {
      const trimmed = serverUrl.trim()
      if (trimmed && !parseServerUrl(trimmed)) {
        throw new InvalidRemoteAccessSetting(
          'The server address must be wss://<host>, or ws:// on 127.0.0.1, [::1] or localhost',
        )
      }
      if (enabled && !trimmed) throw new InvalidRemoteAccessSetting('Enter the server address first')
      savedServer = trimmed || null
    }
    let savedClient = this.saved?.clientUrl ?? null
    if (!this.env.CLIENT_URL) {
      const trimmed = clientUrl?.trim() ?? ''
      const parsed = trimmed ? parseClientUrl(trimmed) : null
      if (trimmed && !parsed) {
        throw new InvalidRemoteAccessSetting('The client address must be an http:// or https:// URL')
      }
      savedClient = parsed
    }
    return { enabled, serverUrl: savedServer, clientUrl: savedClient }
  }

  /** Opens the tunnel to the server address in use, unless one to it is already open. Throws when it cannot. */
  private connect() {
    const url = this.serverTunnelUrl()
    if (!url) throw new InvalidRemoteAccessSetting('No valid server address is known')
    if (this.tunnel && this.tunnelUrl === url && this.tunnel.status !== 'stopped') return
    const keys = this.loadKeys()
    const secret = this.secret
    if (!keys || !secret) throw new Error('the machine secret or the access keys could not be read')
    this.ensureKey(keys, secret)
    this.disconnect()
    const create = this.options.createTunnel ?? ((options) => new TunnelClient(options))
    const tunnel = create({
      url,
      secret,
      expectedMachineId: machineIdFromSecret(secret),
      authorize: (key) => keys.authorize(key),
      handle: (request, principal) => this.options.handle(request, principal),
      openSocket: (path, headers, conn, principal) => this.options.openSocket(path, headers, conn, principal),
    })
    this.tunnel = tunnel
    this.tunnelUrl = url
    tunnel.start()
  }

  /** Stops the tunnel, which ends its channels. A stopped `TunnelClient` cannot start again, so it is dropped. */
  private disconnect() {
    this.tunnel?.stop()
    this.tunnel = null
    this.tunnelUrl = null
  }

  /**
   * Creates the `default` key the first time remote access is on, and prints
   * its connect link. Only its hash is kept, so this is the one time it is
   * shown. Throws when the key cannot be saved.
   */
  private ensureKey(keys: AccessKeys, secret: string) {
    if (keys.size > 0) return
    let key: string
    try {
      key = keys.create(DEFAULT_KEY_NAME)
    } catch (error) {
      throw new Error(`the access key could not be saved (${error instanceof Error ? error.message : error})`)
    }
    const machineId = machineIdFromSecret(secret)
    const clientUrl = linkClientUrl(this.env, this.saved)
    const target = clientUrl
      ? `Connect link: ${connectLink(clientUrl, machineId, key)}`
      : `Machine id: ${machineId}\nAccess key: ${key}`
    console.log(
      `remote access key created. It will not be shown again; run \`bun run host:rotate-key\` for a new one.\n${target}`,
    )
  }

  /** Loads the machine secret, creating it, and the access keys, once. Null when either cannot be read. */
  private loadKeys(): AccessKeys | null {
    if (this.keys) return this.keys
    try {
      this.secret ??= loadOrCreateMachineSecret(this.options.secretFile)
      this.keys = new AccessKeys(new AccessKeyRepository(this.options.keysFile), {
        // The tunnel open at the time of a rotation, not the one open when the keys were loaded.
        onRevoked: (keyIds) => this.tunnel?.closeChannels(keyIds),
      })
    } catch (error) {
      // The repositories' messages never contain the secret, a key or a hash.
      console.error(`no tunnel: ${error instanceof Error ? error.message : 'a secret file could not be read'}`)
      return null
    }
    return this.keys
  }

  /** The machine id, reading an existing secret without creating one. Null until a secret exists. */
  private machineId(): string | null {
    if (!this.secret && existsSync(this.options.secretFile)) {
      try {
        this.secret = loadOrCreateMachineSecret(this.options.secretFile)
      } catch {
        return null
      }
    }
    return this.secret ? machineIdFromSecret(this.secret) : null
  }

  private serverUrl(): string | null {
    return this.env.SERVER_URL ?? this.saved?.serverUrl ?? null
  }

  private serverTunnelUrl(): string | null {
    const serverUrl = this.serverUrl()
    return serverUrl ? parseServerUrl(serverUrl) : null
  }
}
