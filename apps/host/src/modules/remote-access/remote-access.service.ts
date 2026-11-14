import { existsSync } from 'node:fs'
import { hostname } from 'node:os'
import {
  type AuditLogResponse,
  CLOSE_SESSION_ENDED,
  type DevicesResponse,
  type LinkBody,
  machineFingerprint,
  type PreviewLinkBody,
  type PreviewLinkResponse,
  type RemoteAccessStatus,
  type SessionsResponse,
  type UpdateRemoteAccessBody,
} from '@orch/shared'
import type { Principal } from '../../lib/principal'
import { AccessKeyRepository } from '../access/access.repository'
import { AccessKeys, connectLink, DEFAULT_KEY_NAME, type RemoteAccess } from '../access/access.service'
import type { E2eSessions } from '../e2e/e2e.service'
import { DEFAULT_SERVER_URL } from '../settings/settings.service'
import { loadOrCreateMachineKey, type MachineKey } from '../tunnel/tunnel.repository'
import { type EnrollAnswer, type EnrollRequest, TunnelClient, type TunnelClientOptions } from '../tunnel/tunnel.service'
import type { OpenSocket } from '../tunnel/tunnel-channels.service'
import type { Authorization, Credentials, Refusal, TunnelHandler } from '../tunnel/tunnel-http.service'
import { linkClientUrl, RemoteAccessAddresses, type RemoteAddresses } from './addresses.service'
import type { AuditLogService } from './audit-log.service'
import type { DevicesRepository } from './devices.repository'
import { DevicesService } from './devices.service'
import type { LinkedAccountRepository, SavedLinkedAccount } from './linked-account.repository'
import { AmbiguousDevice, InvalidRemoteAccessSetting, LinkError, UnknownDevice } from './remote-access.errors'
import type { RemoteAccessRepository, RemoteAccessSettings } from './remote-access.repository'
import { groupSessions } from './sessions.service'
import { TunnelAccess } from './tunnel-access.service'

export { DEFAULT_SERVER_URL }

/** The parts of a `TunnelClient` the service drives. */
export type Tunnel = Pick<TunnelClient, 'start' | 'stop' | 'closeChannels' | 'listChannels' | 'status' | 'enroll'>

export interface RemoteAccessServiceOptions {
  repository: RemoteAccessRepository
  /** Where the linked account is kept. */
  linkedAccounts: LinkedAccountRepository
  /** Where the browsers approved for the linked account are kept. */
  devices: DevicesRepository
  /** Where tunneled sockets and refusals are recorded, for the owner to read. */
  audit: AuditLogService
  /** The end-to-end sessions browsers opened, closed together with the sockets of the same access. */
  e2eSessions: Pick<E2eSessions, 'closeWhere' | 'closeAll' | 'get'>
  /** The machine key file, created the first time remote access is needed. */
  machineKeyFile: string
  /** The access keys file. */
  keysFile: string
  /** The settings file, where a changed address is saved for the next start. */
  settingsFile: string
  /** The addresses in use until the host restarts. */
  addresses: RemoteAddresses
  /**
   * True when a relay address set by the environment turns the tunnel on at
   * start, whatever the saved flag says: the dev host's `SERVER_URL`. A packaged
   * host passes false.
   */
  autoEnable: boolean
  /** The server address used when none is set. Defaults to `DEFAULT_SERVER_URL`. */
  defaultServerUrl?: string
  /** Answers each tunneled request. Read only once a tunnel is open, so it may close over the app built later. */
  handle: TunnelHandler
  /** Opens each tunneled WebSocket. Read only once a tunnel is open, like `handle`. */
  openSocket: OpenSocket
  /** Builds the tunnel. Defaults to a real `TunnelClient`; tests pass a fake so they need no network. */
  createTunnel?: (options: TunnelClientOptions) => Tunnel
}

/** The name a link gives this machine: its host name, trimmed and cut to 64 characters, or `this machine`. */
export function hostMachineName(name = hostname()): string {
  return name.trim().slice(0, 64).trim() || 'this machine'
}

/** The status and message each `enroll.failed` code answers with. */
const ENROLL_FAILURES = {
  invalid_key: [400, 'This key is unknown, used or expired'],
  rate_limited: [429, 'Too many tries. Wait a minute, then try again'],
  unavailable: [503, 'The server could not check the key. Try again later'],
} as const

/**
 * Owns remote access while the host runs: the saved setting, the machine
 * key, the access keys, the tunnel, the linked account and its devices. The
 * addresses are the ones loaded at start: a changed one is saved to the
 * settings file for the next start, and only the on/off flag applies at once.
 * With `autoEnable`, a relay address from the environment turns the tunnel on
 * at start whatever the saved flag says. Nothing is read from disk until `start()`.
 */
export class RemoteAccessService {
  private saved: RemoteAccessSettings | null = null
  /** The addresses in use, and the ones saved for the next start. */
  private readonly addresses: RemoteAccessAddresses
  private linked: SavedLinkedAccount | null = null
  private machineKey: MachineKey | null = null
  private keys: AccessKeys | null = null
  private tunnel: Tunnel | null = null
  /** The tunnel URL `tunnel` dials, so an update to the same address keeps it. */
  private tunnelUrl: string | null = null
  /** The browsers approved on this machine, and those waiting. */
  private readonly devices: DevicesService
  private readonly access: TunnelAccess

  constructor(private readonly options: RemoteAccessServiceOptions) {
    this.addresses = new RemoteAccessAddresses(options.addresses, options.settingsFile, options.defaultServerUrl)
    this.devices = new DevicesService(options.devices)
    this.access = new TunnelAccess({
      devices: this.devices,
      keys: () => this.keys,
      linked: () => this.linked,
      machineId: () => this.machineId(),
      serverUrl: () => this.serverUrl(),
    })
  }

  /**
   * Reads the saved setting and opens the tunnel when the setting is on, or
   * when `autoEnable` is on and the environment sets the relay address. Any
   * problem is logged and leaves the host local only; a setting file that is
   * not valid is left as it is.
   */
  start() {
    try {
      const saved = this.options.repository.load()
      this.saved = saved && { enabled: saved.enabled }
    } catch (error) {
      console.error(`remote access is off: ${error instanceof Error ? error.message : 'its setting could not be read'}`)
    }
    this.addresses.load()
    try {
      this.linked = this.options.linkedAccounts.load()
    } catch (error) {
      console.error(`no linked account: ${error instanceof Error ? error.message : 'it could not be read'}`)
    }
    this.devices.start()
    const { relayUrl } = this.addresses.inUse
    if (!(this.autoEnabled() || this.saved?.enabled)) return
    if (!this.serverTunnelUrl()) {
      console.error(
        `${relayUrl.setBy ?? 'The server address'} must be wss://<host>, or ws:// on 127.0.0.1, [::1] or localhost. Running without a tunnel`,
      )
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

  /** The setting in use and where the tunnel stands. It never holds the machine's private key, an access key or a hash. */
  status(): RemoteAccessStatus {
    const machineId = this.machineId()
    return {
      enabled: this.tunnel !== null,
      ...this.addresses.status(),
      machineId,
      machineFingerprint: machineId === null ? null : machineFingerprint(machineId),
      tunnel: this.tunnel?.status ?? 'off',
      linkedAccount: this.linked && {
        name: this.linked.name,
        maskedEmail: this.linked.maskedEmail,
        serverUrl: this.linked.serverUrl,
        linkedAt: this.linked.linkedAt,
      },
    }
  }

  /**
   * Saves the addresses to the settings file for the next start, and the flag,
   * then opens or closes the tunnel to match; an open tunnel keeps the address
   * it has. An address set by a flag or the environment keeps the saved one as
   * it was. Throws `InvalidRemoteAccessSetting` for an address the host
   * refuses, before anything is saved or the tunnel changes.
   */
  update(input: UpdateRemoteAccessBody): RemoteAccessStatus {
    this.addresses.save(input)
    this.options.repository.save({ enabled: input.enabled })
    this.saved = { enabled: input.enabled }
    if (input.enabled) this.connect()
    else this.disconnect({ remoteOff: true })
    return this.status()
  }

  /**
   * Asks the server which account `key` belongs to, over the open tunnel,
   * without using the key or saving anything. Throws `LinkError`.
   */
  async previewLink({ key }: PreviewLinkBody): Promise<PreviewLinkResponse> {
    const tunnel = this.linkTunnel()
    const answer = await this.enroll(tunnel, { type: 'enroll.preview', key })
    if (answer.type !== 'enroll.previewed')
      throw new LinkError(502, 'The server sent an answer the host does not expect')
    return {
      serverUrl: this.serverUrl(),
      serverUrlIsDefault: this.addresses.isDefault(),
      account: answer.account,
      fingerprint: answer.fingerprint,
      expiresAt: answer.expiresAt,
    }
  }

  /**
   * Redeems `key` over the open tunnel and remembers the account, once the
   * server confirms it linked this machine's own id. `serverUrl` must be the
   * address in use, so a key is only ever used with the server the user
   * confirmed. Throws `LinkError` before anything is saved.
   */
  async link({ key, serverUrl }: LinkBody): Promise<RemoteAccessStatus> {
    if (this.linked) throw new LinkError(409, 'Unlink first')
    const inUse = this.serverUrl()
    if (serverUrl !== inUse) throw new LinkError(409, 'The server address changed. Preview the key again')
    const tunnel = this.linkTunnel()
    const answer = await this.enroll(tunnel, { type: 'enroll.redeem', key, name: hostMachineName() })
    if (answer.type !== 'enroll.redeemed')
      throw new LinkError(502, 'The server sent an answer the host does not expect')
    if (answer.machineId !== this.machineId()) {
      throw new LinkError(502, 'The server linked another machine id than this host has. Nothing was saved')
    }
    // Linked while this call waited: keep the first account rather than overwrite it.
    if (this.linked) throw new LinkError(409, 'Unlink first')
    // Approvals belong to an account, so none left from an earlier one carries over.
    this.devices.clear()
    const account = {
      ...answer.account,
      serverUrl: inUse,
      linkedAt: new Date().toISOString(),
      accountId: answer.accountId,
      relayKeys: answer.relayKeys,
    }
    this.options.linkedAccounts.save(account)
    this.linked = account
    return this.status()
  }

  /**
   * Forgets the linked account on this machine, with its approved and waiting
   * devices, and closes the sockets it opened. The server still lists the
   * machine until it is unlinked there.
   */
  unlink(): RemoteAccessStatus {
    this.options.linkedAccounts.remove()
    this.linked = null
    this.devices.clear()
    this.closeAccess((principal) => principal.kind === 'account', 'account unlinked')
    return this.status()
  }

  /** The browsers approved to open this machine through the linked account, and those waiting. */
  listDevices(): DevicesResponse {
    return this.devices.list()
  }

  /**
   * Approves the waiting browser with the fingerprint the owner typed. One
   * already approved answers the list unchanged. Throws `UnknownDevice` when
   * none matches and `AmbiguousDevice` when more than one does.
   */
  approveDevice(fingerprint: string): DevicesResponse {
    const result = this.devices.approve(fingerprint)
    if (result === 'none') throw new UnknownDevice(fingerprint)
    if (result === 'several') throw new AmbiguousDevice(fingerprint)
    return this.devices.list()
  }

  /**
   * Dismisses a waiting browser, or revokes an approved one and closes the
   * sockets and end-to-end sessions it opened, with a key or through the
   * account. An unknown id changes nothing.
   */
  removeDevice(id: string): DevicesResponse {
    if (this.devices.remove(id) === 'approved') {
      this.closeAccess((principal) => principal.deviceId === id, 'device revoked')
    }
    return this.devices.list()
  }

  /** The devices with authorized tunneled sockets open, one entry each, newest first; see `groupSessions`. */
  listSessions(): SessionsResponse {
    return { sessions: groupSessions(this.tunnel?.listChannels() ?? []) }
  }

  /**
   * Closes the tunneled sockets of the device with this id, with the default
   * `CLOSE_ACCESS_DENIED`, and its end-to-end sessions, and answers the fresh list. The device stays
   * approved, so it can open the machine again; an unknown id changes nothing.
   */
  endSession(id: string): SessionsResponse {
    this.closeAccess((principal) => principal.deviceId === id, 'session ended by owner')
    return this.listSessions()
  }

  /**
   * Handles the server's `session.ended`: when it names the linked account,
   * closes with `CLOSE_SESSION_ENDED` the sockets that account's tickets
   * opened, and its end-to-end sessions, so browsers still signed in reconnect
   * with a fresh ticket. It never
   * touches key sockets, the link or the devices, and any other account,
   * or no linked account, closes nothing.
   */
  private sessionEnded(accountId: string) {
    const linked = this.linked?.accountId
    if (!linked || accountId !== linked) return
    this.closeAccess(
      (principal) => principal.kind === 'account' && principal.accountId === linked,
      'session ended',
      CLOSE_SESSION_ENDED,
    )
  }

  /**
   * Closes the tunneled sockets and the end-to-end sessions `revoked` matches,
   * the sockets with `code` (the tunnel's `CLOSE_ACCESS_DENIED` when absent).
   * Every path that ends access goes through here, so the two never drift apart.
   */
  private closeAccess(revoked: (principal: Principal) => boolean, reason: string, code?: number) {
    this.tunnel?.closeChannels(revoked, reason, code)
    this.options.e2eSessions.closeWhere(revoked)
  }

  /** Decides a tunneled request or socket; see `TunnelAccess.authorize`. */
  authorize(credentials: Credentials, refused?: (refusal: Refusal) => void): Authorization {
    return this.access.authorize(credentials, refused)
  }

  /** The newest remote access recorded on this machine, newest first; see `AuditLogService.recent`. */
  auditLog(): AuditLogResponse {
    return { entries: this.options.audit.recent() }
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
    return { keys, machineId, clientUrl: linkClientUrl(this.addresses.inUse.clientUrl) }
  }

  /** Closes the tunnel and writes pending key use, for shutdown. */
  shutdown() {
    this.disconnect()
    this.keys?.flush()
  }

  /** True when the environment sets the relay address and `autoEnable` lets it turn the tunnel on. */
  private autoEnabled(): boolean {
    return this.options.autoEnable && this.addresses.inUse.relayUrl.source === 'env'
  }

  /** Opens the tunnel to the server address in use, unless one to it is already open. Throws when it cannot. */
  private connect() {
    const url = this.serverTunnelUrl()
    if (!url) throw new InvalidRemoteAccessSetting('No valid server address is known')
    if (this.tunnel && this.tunnelUrl === url && this.tunnel.status !== 'stopped') return
    const keys = this.loadKeys()
    const machineKey = this.machineKey
    if (!keys || !machineKey) throw new Error('the machine key or the access keys could not be read')
    this.ensureKey(keys, machineKey.machineId)
    this.disconnect()
    const create = this.options.createTunnel ?? ((options) => new TunnelClient(options))
    const tunnel = create({
      url,
      key: machineKey,
      expectedMachineId: machineKey.machineId,
      authorize: (credentials, refused) => this.authorize(credentials, refused),
      handle: (request, principal) => this.options.handle(request, principal),
      e2eSession: (sessionId) => this.options.e2eSessions.get(sessionId),
      openSocket: (path, headers, conn, principal) => this.options.openSocket(path, headers, conn, principal),
      onSessionEnded: (accountId) => this.sessionEnded(accountId),
      record: (event) => this.options.audit.record(event),
    })
    this.tunnel = tunnel
    this.tunnelUrl = url
    tunnel.start()
  }

  /**
   * Stops the tunnel, which ends its channels, and closes every end-to-end session. A stopped `TunnelClient` cannot
   * start again, so it is dropped.
   * `remoteOff` is for the owner turning remote access off, so the server can show it instead of Offline.
   */
  private disconnect(options?: { remoteOff: true }) {
    this.tunnel?.stop(options)
    this.options.e2eSessions.closeAll()
    this.tunnel = null
    this.tunnelUrl = null
  }

  /**
   * Creates the `default` key the first time remote access is on, and prints
   * its connect link. Only its hash is kept, so this is the one time it is
   * shown. Throws when the key cannot be saved.
   */
  private ensureKey(keys: AccessKeys, machineId: string) {
    if (keys.size > 0) return
    let key: string
    try {
      key = keys.create(DEFAULT_KEY_NAME)
    } catch (error) {
      throw new Error(`the access key could not be saved (${error instanceof Error ? error.message : error})`)
    }
    const clientUrl = linkClientUrl(this.addresses.inUse.clientUrl)
    const target = clientUrl
      ? `Connect link: ${connectLink(clientUrl, machineId, key)}`
      : `Machine id: ${machineId}\nAccess key: ${key}`
    console.log(
      `remote access key created. It will not be shown again; run \`bun run host:rotate-key\` for a new one.\n${target}`,
    )
  }

  /** Loads the machine key, creating it, and the access keys, once. Null when either cannot be read. */
  private loadKeys(): AccessKeys | null {
    if (this.keys) return this.keys
    try {
      this.machineKey ??= loadOrCreateMachineKey(this.options.machineKeyFile)
      this.keys = new AccessKeys(new AccessKeyRepository(this.options.keysFile), {
        // The tunnel open at the time of a rotation, not the one open when the keys were loaded.
        onRevoked: (keyIds) =>
          this.closeAccess((principal) => principal.kind === 'key' && keyIds.includes(principal.keyId), 'key rotated'),
      })
    } catch (error) {
      // The repositories' messages never contain the machine key, an access key or a hash.
      console.error(`no tunnel: ${error instanceof Error ? error.message : 'a key file could not be read'}`)
      return null
    }
    return this.keys
  }

  /**
   * The machine's public key, which browsers pin, reading an existing machine key without creating one. Null until
   * a key exists. The private key never leaves the `MachineKey`.
   */
  machinePublicKey(): string | null {
    return this.signingKey()?.publicKey ?? null
  }

  /** The machine id, reading an existing machine key without creating one. Null until a key exists. */
  private machineId(): string | null {
    return this.signingKey()?.machineId ?? null
  }

  /**
   * The machine key, which also signs end-to-end handshakes, loaded from an existing file but never created. Null until
   * a key exists or when it can't be read. Its private key never leaves its `sign`.
   */
  signingKey(): MachineKey | null {
    if (!this.machineKey && existsSync(this.options.machineKeyFile)) {
      try {
        this.machineKey = loadOrCreateMachineKey(this.options.machineKeyFile)
      } catch {
        return null
      }
    }
    return this.machineKey
  }

  /**
   * The tunnel to link through: there must be no linked account yet and a
   * connected tunnel. A tunnel is never opened just for this, since opening
   * one creates the access key and serves remote requests.
   */
  private linkTunnel(): Tunnel {
    if (this.linked) throw new LinkError(409, 'Unlink first')
    const tunnel = this.tunnel
    if (tunnel?.status !== 'connected') {
      throw new LinkError(409, 'Turn remote access on and wait until it is connected')
    }
    return tunnel
  }

  /** Sends an enrollment frame, turning `enroll.failed`, a timeout and a lost tunnel into `LinkError`s. */
  private async enroll(
    tunnel: Tunnel,
    request: EnrollRequest,
  ): Promise<Exclude<EnrollAnswer, { type: 'enroll.failed' }>> {
    let answer: EnrollAnswer
    try {
      answer = await tunnel.enroll(request)
    } catch {
      throw new LinkError(503, 'The server did not answer. Check the connection and try again')
    }
    if (answer.type === 'enroll.failed') {
      const [status, message] = ENROLL_FAILURES[answer.code]
      throw new LinkError(status, message)
    }
    return answer
  }

  /** The server address in use, as loaded at start. */
  private serverUrl(): string {
    return this.addresses.inUse.relayUrl.value
  }

  private serverTunnelUrl(): string | null {
    return this.addresses.tunnelUrl()
  }
}
