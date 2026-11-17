import { existsSync } from 'node:fs'
import { hostname } from 'node:os'
import {
  type AuditLogResponse,
  CLOSE_SESSION_ENDED,
  type ConnectBody,
  type ConnectOutcome,
  type ConnectOutcomeKind,
  type DevicesResponse,
  type DisconnectResponse,
  machineFingerprint,
  parseServerUrl,
  type RemoteAccessStatus,
  type SessionsResponse,
  sameServerUrl,
} from '@orch/shared'
import type { Principal } from '../../lib/principal'
import type { E2eSessions } from '../e2e/e2e.service'
import { DEFAULT_SERVER_URL } from '../settings/settings.service'
import { loadOrCreateMachineKey, type MachineKey } from '../tunnel/tunnel.repository'
import { TunnelClient, type TunnelClientOptions } from '../tunnel/tunnel.service'
import type { EnrollAnswer, EnrollRequest, EnrollWaiting } from '../tunnel/tunnel-asks.service'
import type { OpenSocket } from '../tunnel/tunnel-channels.service'
import type { Authorization, Credentials, Refusal, TunnelHandler } from '../tunnel/tunnel-http.service'
import { RemoteAccessAddresses, type RemoteAddresses, SERVER_URL_RULE } from './addresses.service'
import type { AuditLogService } from './audit-log.service'
import { ConnectAttempt } from './connect-attempt.service'
import type { DevicesRepository } from './devices.repository'
import { DevicesService } from './devices.service'
import type { LinkedAccountRepository, SavedLinkedAccount } from './linked-account.repository'
import {
  AmbiguousDevice,
  ConnectError,
  ENROLL_FAILURES,
  InvalidRemoteAccessSetting,
  OUTCOME_MESSAGES,
  UnknownDevice,
} from './remote-access.errors'
import { groupSessions } from './sessions.service'
import { TunnelAccess } from './tunnel-access.service'

export { DEFAULT_SERVER_URL }

/** The parts of a `TunnelClient` the service drives. */
export type Tunnel = Pick<
  TunnelClient,
  'start' | 'stop' | 'closeChannels' | 'listChannels' | 'status' | 'enroll' | 'unlink' | 'whenConnected'
>

/** How long Connect waits for a new tunnel to connect before it gives up. */
export const CONNECT_TIMEOUT_MS = 15_000

export interface RemoteAccessServiceOptions {
  /** Where the account this machine is connected to is kept. */
  linkedAccounts: LinkedAccountRepository
  /** Where the browsers approved for the linked account are kept. */
  devices: DevicesRepository
  /** Where tunneled sockets and refusals are recorded, for the owner to read. */
  audit: AuditLogService
  /** The end-to-end sessions browsers opened, closed together with the sockets of the same access. */
  e2eSessions: Pick<E2eSessions, 'closeWhere' | 'closeAll' | 'get'>
  /** The machine key file, created the first time remote access is needed. */
  machineKeyFile: string
  /** The settings file, where Connect saves the server address it uses. */
  settingsFile: string
  /** The addresses the host starts with. */
  addresses: RemoteAddresses
  /** The server address used when none is set. Defaults to `DEFAULT_SERVER_URL`. */
  defaultServerUrl?: string
  /** How long Connect waits for the tunnel to connect. Defaults to `CONNECT_TIMEOUT_MS`. */
  connectTimeoutMs?: number
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

/**
 * Owns remote access while the host runs: the machine key, the tunnel,
 * the account this machine is connected to and its devices. The
 * tunnel runs exactly while the machine is connected: it opens at start when
 * `linked-account.json` holds an account, and Connect and Disconnect open and
 * stop it. Nothing is read from disk until `start()`.
 */
export class RemoteAccessService {
  /** The addresses in use. Connect changes the server address. */
  private readonly addresses: RemoteAccessAddresses
  private linked: SavedLinkedAccount | null = null
  private machineKey: MachineKey | null = null
  private tunnel: Tunnel | null = null
  /** The browsers approved on this machine, and those waiting. */
  private readonly devices: DevicesService
  private readonly access: TunnelAccess
  /** The Connect on its way or waiting for the owner, so a second one is refused and Cancel can end it. */
  private attempt: ConnectAttempt | null = null
  /** How the last Connect that waited ended unlinked, until the next Connect. */
  private outcome: ConnectOutcome | null = null
  /** The Disconnect on its way, which a second call shares. */
  private disconnecting: Promise<DisconnectResponse> | null = null

  constructor(private readonly options: RemoteAccessServiceOptions) {
    this.addresses = new RemoteAccessAddresses(options.addresses, options.settingsFile, options.defaultServerUrl)
    this.devices = new DevicesService(options.devices)
    this.access = new TunnelAccess({
      devices: this.devices,
      linked: () => this.linked,
      machineId: () => this.machineId(),
      serverUrl: () => this.serverUrl(),
    })
  }

  /**
   * Reads the linked account and opens the tunnel when there is one, since a
   * machine with an account counts as connected. Any problem is logged and
   * leaves the host local only; a linked account file that is not valid is
   * left as it is.
   */
  start() {
    try {
      this.linked = this.options.linkedAccounts.load()
    } catch (error) {
      console.error(`not connected: ${error instanceof Error ? error.message : 'the linked account could not be read'}`)
    }
    this.devices.start()
    if (!this.linked) return
    const { relayUrl } = this.addresses.inUse
    if (!this.serverTunnelUrl()) {
      console.error(
        `${relayUrl.setBy ?? 'The server address'} must be wss://<host>, or ws:// on 127.0.0.1, [::1] or localhost. Running without a tunnel`,
      )
      return
    }
    if (this.linked.serverUrl !== this.serverUrl()) {
      console.warn(
        `warning: this machine is connected through ${this.linked.serverUrl}, but the server address in use is ${relayUrl.value}, so its account can't open it. Disconnect, then connect again`,
      )
    }
    try {
      this.openTunnel()
    } catch (error) {
      console.error(`no tunnel: ${error instanceof Error ? error.message : 'remote access could not start'}`)
    }
  }

  /** The addresses in use and where the tunnel stands. It never holds the machine's private key. */
  status(): RemoteAccessStatus {
    const machineId = this.machineId()
    return {
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
      connectRequest: this.attempt?.expiresAt ? { expiresAt: this.attempt.expiresAt } : null,
      connectOutcome: this.outcome,
    }
  }

  /**
   * Starts connecting this machine to the account of `email` with the
   * enrollment key `key`, through `serverUrl`: it makes the address the one in
   * use and saves it (unless a flag or variable sets it), clears the approved
   * and waiting devices, opens the tunnel there at once and waits for it, and
   * sends the key with the email. It answers once the server holds the request
   * for the owner, with `connectRequest` set. The owner's answer comes later:
   * an accept saves the account once the server confirms it linked this
   * machine's own id; a reject, the key's time running out, the tunnel
   * dropping or `cancelConnect` ends the request unlinked, stops the tunnel and
   * sets `connectOutcome`. Throws `ConnectError` or `InvalidRemoteAccessSetting`;
   * on any failure nothing is linked and the tunnel is stopped. No message holds
   * the key or the email.
   */
  async connect({ email, key, serverUrl }: ConnectBody): Promise<RemoteAccessStatus> {
    if (this.linked) throw new ConnectError(409, 'This machine is already connected. Disconnect it first')
    if (this.attempt) {
      throw new ConnectError(
        409,
        this.attempt.expiresAt === null
          ? 'This machine is already connecting'
          : 'This machine is already waiting for its connect request to be accepted. Cancel it first',
      )
    }
    const address = serverUrl.trim()
    if (!parseServerUrl(address)) throw new ConnectError(400, SERVER_URL_RULE)
    const { relayUrl } = this.addresses.inUse
    if (relayUrl.setBy && !sameServerUrl(address, relayUrl.value)) {
      throw new ConnectError(
        409,
        `${relayUrl.setBy} sets the server address. Connect to ${relayUrl.value}, or change it`,
      )
    }
    const attempt = new ConnectAttempt()
    this.attempt = attempt
    this.outcome = null
    try {
      this.addresses.use(address)
      // Approvals belong to an account, so none left from an earlier one carries over or uses the new tunnel.
      this.devices.clear()
      const tunnel = this.openTunnel()
      try {
        await tunnel.whenConnected(this.options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS)
      } catch {
        throw new ConnectError(503, 'Could not connect to the server. Check the address and try again')
      }
      const waiting = await this.request(tunnel, { type: 'enroll.request', key, email, name: hostMachineName() })
      if (attempt.ended) throw new ConnectError(409, attempt.outcome?.message ?? OUTCOME_MESSAGES.cancelled)
      attempt.wait(waiting.expiresInMs, () => this.endAttempt(attempt, 'expired'))
      waiting.answer.then(
        (answer) => this.answered(attempt, tunnel, answer),
        () => this.endAttempt(attempt, 'failed'),
      )
      return this.status()
    } catch (error) {
      // A cancel already stopped the tunnel, and a new Connect may have opened another since.
      if (!attempt.end('failed')) throw new ConnectError(409, attempt.outcome?.message ?? OUTCOME_MESSAGES.cancelled)
      this.attempt = null
      // Not connected, so no tunnel may stay open.
      this.stopTunnel()
      throw error
    }
  }

  /**
   * Ends the Connect on its way or waiting for the owner, before the machine
   * is linked: stops the tunnel, so the server drops the request, and sets
   * `connectOutcome` to `cancelled`. With none on its way it changes nothing.
   */
  cancelConnect(): RemoteAccessStatus {
    if (this.attempt) this.endAttempt(this.attempt, 'cancelled')
    return this.status()
  }

  /**
   * Takes the owner's final answer to `attempt`'s request: a reject ends it,
   * and an accept of this machine's own id over the same tunnel saves the account.
   */
  private answered(attempt: ConnectAttempt, tunnel: Tunnel, answer: EnrollAnswer) {
    if (attempt.ended) return
    if (answer.type === 'enroll.failed') {
      this.endAttempt(attempt, answer.code === 'rejected' ? 'rejected' : 'failed', ENROLL_FAILURES[answer.code][1])
      return
    }
    if (answer.machineId !== this.machineId() || this.tunnel !== tunnel) {
      this.endAttempt(attempt, 'failed', 'The server linked another machine id than this host has. Nothing was saved')
      return
    }
    const account = {
      ...answer.account,
      serverUrl: this.serverUrl(),
      linkedAt: new Date().toISOString(),
      accountId: answer.accountId,
      relayKeys: answer.relayKeys,
    }
    try {
      this.options.linkedAccounts.save(account)
    } catch {
      this.endAttempt(
        attempt,
        'failed',
        'The account could not be saved on this machine. Remove the machine in the client, then connect again',
      )
      return
    }
    attempt.link()
    this.attempt = null
    this.linked = account
  }

  /**
   * Ends `attempt` unlinked as `kind`, with `message` or the kind's own: the
   * status shows the outcome, and the tunnel stops, which ends the request on
   * the server. An attempt that already ended stays as it was.
   */
  private endAttempt(attempt: ConnectAttempt, kind: ConnectOutcomeKind, message?: string) {
    if (!attempt.end(kind, message) || this.attempt !== attempt) return
    this.attempt = null
    this.outcome = attempt.outcome
    this.stopTunnel()
  }

  /**
   * Disconnects this machine from its account. While the tunnel is connected
   * and the account's id is known, it first asks the server to remove the
   * machine from the account's list. Then, whatever the server answered, it
   * forgets the account and its approved and waiting devices, closes the
   * sockets the account opened, and stops the tunnel with `remote.off`.
   * `removedFromAccount` says whether the server removed it. A machine that
   * is not connected changes nothing.
   */
  disconnect(): Promise<DisconnectResponse> {
    this.disconnecting ??= this.disconnectNow().finally(() => {
      this.disconnecting = null
    })
    return this.disconnecting
  }

  private async disconnectNow(): Promise<DisconnectResponse> {
    const linked = this.linked
    if (!linked) return { status: this.status(), removedFromAccount: false }
    const removedFromAccount = await this.removeFromAccount(linked)
    this.options.linkedAccounts.remove()
    this.linked = null
    this.devices.clear()
    this.closeAccess(() => true, 'disconnected')
    this.stopTunnel({ remoteOff: true })
    return { status: this.status(), removedFromAccount }
  }

  /** Asks the server over a connected tunnel to remove this machine from `linked`'s list. True once it has. */
  private async removeFromAccount(linked: SavedLinkedAccount): Promise<boolean> {
    const tunnel = this.tunnel
    if (!linked.accountId || tunnel?.status !== 'connected') return false
    try {
      return (await tunnel.unlink(linked.accountId)).type === 'unlinked'
    } catch {
      return false
    }
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
   * sockets and end-to-end sessions it opened. An unknown id changes nothing.
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
   * with a fresh ticket. It never touches the link or the devices, and any
   * other account, or no linked account, closes nothing.
   */
  private sessionEnded(accountId: string) {
    const linked = this.linked?.accountId
    if (!linked || accountId !== linked) return
    this.closeAccess((principal) => principal.accountId === linked, 'session ended', CLOSE_SESSION_ENDED)
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

  /** Ends a Connect on its way and closes the tunnel, for shutdown. */
  shutdown() {
    if (this.attempt) this.endAttempt(this.attempt, 'failed', 'The host stopped. Nothing was linked')
    this.stopTunnel()
  }

  /** Opens a new tunnel to the server address in use, stopping any open one. Throws when it cannot. */
  private openTunnel(): Tunnel {
    const url = this.serverTunnelUrl()
    if (!url) throw new InvalidRemoteAccessSetting('No valid server address is known')
    const machineKey = this.loadMachineKey()
    if (!machineKey) throw new Error('the machine key could not be read')
    this.stopTunnel()
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
    tunnel.start()
    return tunnel
  }

  /**
   * Stops the tunnel, which ends its channels, and closes every end-to-end session. A stopped `TunnelClient` cannot
   * start again, so it is dropped.
   * `remoteOff` is for the owner disconnecting, so the server can show it instead of Offline.
   */
  private stopTunnel(options?: { remoteOff: true }) {
    this.tunnel?.stop(options)
    this.options.e2eSessions.closeAll()
    this.tunnel = null
  }

  /** Loads the machine key, creating it, once. Null when it cannot be read. */
  private loadMachineKey(): MachineKey | null {
    try {
      this.machineKey ??= loadOrCreateMachineKey(this.options.machineKeyFile)
    } catch (error) {
      // The repository's messages never contain the machine key.
      console.error(`no tunnel: ${error instanceof Error ? error.message : 'the machine key could not be read'}`)
      return null
    }
    return this.machineKey
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

  /** Sends `enroll.request`, turning `enroll.failed`, a timeout and a lost tunnel into `ConnectError`s. */
  private async request(tunnel: Tunnel, request: EnrollRequest): Promise<EnrollWaiting> {
    let answer: Awaited<ReturnType<Tunnel['enroll']>>
    try {
      answer = await tunnel.enroll(request)
    } catch {
      throw new ConnectError(503, 'The server did not answer. Check the connection and try again')
    }
    if (answer.type === 'enroll.failed') {
      const [status, message] = ENROLL_FAILURES[answer.code]
      throw new ConnectError(status, message)
    }
    return answer
  }

  /** The server address in use. */
  private serverUrl(): string {
    return this.addresses.inUse.relayUrl.value
  }

  private serverTunnelUrl(): string | null {
    return this.addresses.tunnelUrl()
  }
}
