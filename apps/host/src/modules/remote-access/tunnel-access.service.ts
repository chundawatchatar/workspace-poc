import type { Principal } from '../../lib/principal'
import type { AccessKeys } from '../access/access.service'
import {
  type Authorization,
  type Credentials,
  DEVICE_NOT_APPROVED,
  type PresentedProof,
  type Refusal,
} from '../tunnel/tunnel-http.service'
import { SpentNonces, type VerifiedDeviceProof, verifyDeviceProof } from './device-proof.service'
import type { DevicesService } from './devices.service'
import type { SavedLinkedAccount } from './linked-account.repository'
import { SpentTickets, verifyRelayTicket } from './relay-ticket.service'

/** What `TunnelAccess` reads from remote access as it is at the time of each request. */
export interface TunnelAccessState {
  /** The browsers approved on this machine, and those waiting. */
  devices: DevicesService
  keys: () => AccessKeys | null
  linked: () => SavedLinkedAccount | null
  machineId: () => string | null
  /** The server address in use. */
  serverUrl: () => string
}

/**
 * Decides tunneled requests and sockets, keeping the relay tickets sockets
 * have opened with and the device proof nonces already used.
 */
export class TunnelAccess {
  /** The relay tickets sockets have opened with, so each opens one socket. */
  private readonly spentTickets = new SpentTickets()
  /** The device proof nonces already used, so each proof admits one request or socket. */
  private readonly spentNonces = new SpentNonces()

  constructor(private readonly state: TunnelAccessState) {}

  /**
   * Decides a tunneled request or socket. A key decides which credential is
   * used: it is checked with the access keys first, and a refused one is
   * refused without reading its proof, so a guessed key never fills the
   * pending list or spends a nonce. A relay ticket opens the machine as the
   * linked account only when it is signed with one of the server's saved
   * public keys, names this machine and the linked account, hasn't expired,
   * and comes through the server address the account was linked through.
   * Either one also needs a device proof for this request whose nonce is
   * unspent, from a device approved on this machine. A valid key or ticket and
   * proof from any other device records it as waiting and answers
   * `DEVICE_NOT_APPROVED`. With `once`, as for a socket, a ticket that already
   * opened one is refused. A linked file without `accountId` or `relayKeys`
   * accepts no ticket. Each refusal tells `refused` why, with the device when
   * its proof verified.
   */
  authorize(
    { key, ticket, device = null, once = false }: Credentials,
    refused: (refusal: Refusal) => void = () => {},
  ): Authorization {
    const machineId = this.state.machineId()
    const now = Date.now()
    const refuse = (reason: Refusal['reason'], verified?: VerifiedDeviceProof, principal?: Principal['kind']) => {
      refused(verified && principal ? { reason, device: { id: verified.deviceId, principal } } : { reason })
      return reason === 'device_not_approved' ? DEVICE_NOT_APPROVED : null
    }
    if (key !== null) {
      const principal = this.state.keys()?.authorize(key)
      if (!principal || !machineId) return refuse('key_refused')
      if (!device) return refuse('proof_refused')
      const verified = this.verifyProof(device, machineId, now)
      if (!verified) return refuse('proof_refused')
      if (!this.isApproved(verified)) return refuse('device_not_approved', verified, 'key')
      return { ...principal, deviceId: verified.deviceId }
    }
    const linked = this.state.linked()
    if (!ticket || !linked?.accountId || !linked.relayKeys || !machineId) return refuse('ticket_refused')
    if (linked.serverUrl !== this.state.serverUrl()) return refuse('ticket_refused')
    const payload = verifyRelayTicket(ticket, { keys: linked.relayKeys, machineId, accountId: linked.accountId, now })
    if (!payload) return refuse('ticket_refused')
    if (!device) return refuse('proof_refused')
    const verified = this.verifyProof(device, machineId, now)
    if (!verified) return refuse('proof_refused')
    if (once && !this.spentTickets.spend(payload, now)) return refuse('ticket_reused', verified, 'account')
    if (!this.isApproved(verified)) return refuse('device_not_approved', verified, 'account')
    return { kind: 'account', accountId: payload.sub, deviceId: verified.deviceId }
  }

  /** The device a proof for this request comes from, spending its nonce, or null when it doesn't verify or was used. */
  private verifyProof(
    { proof, ...request }: PresentedProof,
    machineId: string,
    now: number,
  ): VerifiedDeviceProof | null {
    const verified = verifyDeviceProof(proof, { machineId, ...request, now })
    return verified && this.spentNonces.spend(verified.nonce, now) ? verified : null
  }

  /** True when the device is approved here; otherwise it is recorded as waiting. */
  private isApproved({ deviceId, publicKey }: VerifiedDeviceProof): boolean {
    if (this.state.devices.isApproved(deviceId)) return true
    this.state.devices.recordPending(deviceId, publicKey)
    return false
  }
}
