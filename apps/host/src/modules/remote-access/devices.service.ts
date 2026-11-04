import type { DeviceJwk, DevicesResponse } from '@orch/shared'
import { fingerprintOf } from './device-proof.service'
import type { DevicesRepository, SavedDevice } from './devices.repository'

/** The most devices waiting for approval at once; a new one pushes out the oldest. */
export const MAX_PENDING_DEVICES = 5

/** How long a device waits for approval before it drops out of the list, in milliseconds. */
export const PENDING_DEVICE_TTL_MS = 15 * 60 * 1000

interface PendingEntry {
  id: string
  publicKey: DeviceJwk
  /** Milliseconds. */
  firstSeenAt: number
}

/**
 * The browsers that may open this machine through the linked account. Approved
 * devices are saved and loaded at `start()`. Pending ones are those that
 * offered a valid relay ticket and proof without being approved: they live in
 * memory only, one entry per device, at most `MAX_PENDING_DEVICES` (newest
 * kept), each for `PENDING_DEVICE_TTL_MS`. `now` is in milliseconds.
 */
export class DevicesService {
  private approved: SavedDevice[] = []
  private pending: PendingEntry[] = []

  constructor(
    private readonly repository: DevicesRepository,
    private readonly now: () => number = Date.now,
  ) {}

  /** Loads the approved devices. A file that is not valid is logged and left as it is, and approves none. */
  start() {
    try {
      this.approved = this.repository.load()
    } catch (error) {
      console.error(`no approved devices: ${error instanceof Error ? error.message : 'they could not be read'}`)
    }
  }

  /** True when the device with this id is approved. */
  isApproved(id: string): boolean {
    return this.approved.some((device) => device.id === id)
  }

  /** Records a device that isn't approved as waiting, unless it already is. */
  recordPending(id: string, publicKey: DeviceJwk) {
    if (this.isApproved(id)) return
    const pending = this.fresh()
    if (pending.some((entry) => entry.id === id)) return
    pending.push({ id, publicKey, firstSeenAt: this.now() })
    this.pending = pending.slice(-MAX_PENDING_DEVICES)
  }

  /** Both lists, newest first. */
  list(): DevicesResponse {
    const iso = (ms: number) => new Date(ms).toISOString()
    return {
      pending: this.fresh()
        .reverse()
        .map(({ id, firstSeenAt }) => ({ id, fingerprint: fingerprintOf(id), firstSeenAt: iso(firstSeenAt) })),
      approved: [...this.approved]
        .reverse()
        .map(({ id, approvedAt }) => ({ id, fingerprint: fingerprintOf(id), approvedAt })),
    }
  }

  /**
   * Approves a waiting device and saves it. An approved one stays as it is.
   * False means the id is neither. Throws, approving nothing, when it can't be saved.
   */
  approve(id: string): boolean {
    if (this.isApproved(id)) return true
    const entry = this.fresh().find((candidate) => candidate.id === id)
    if (!entry) return false
    const approved = [
      ...this.approved,
      { id, publicKey: entry.publicKey, approvedAt: new Date(this.now()).toISOString() },
    ]
    this.repository.save(approved)
    this.approved = approved
    this.pending = this.pending.filter((candidate) => candidate.id !== id)
    return true
  }

  /**
   * Dismisses a waiting device, or revokes and unsaves an approved one. Answers
   * what it was, or null for an unknown id.
   */
  remove(id: string): 'pending' | 'approved' | null {
    if (this.isApproved(id)) {
      const approved = this.approved.filter((device) => device.id !== id)
      this.repository.save(approved)
      this.approved = approved
      return 'approved'
    }
    const before = this.pending.length
    this.pending = this.pending.filter((entry) => entry.id !== id)
    return this.pending.length < before ? 'pending' : null
  }

  /** Forgets every device, approved and waiting, for an unlinked account. */
  clear() {
    this.pending = []
    this.approved = []
    this.repository.remove()
  }

  /** The waiting devices that haven't expired, oldest first. */
  private fresh(): PendingEntry[] {
    const cutoff = this.now() - PENDING_DEVICE_TTL_MS
    this.pending = this.pending.filter((entry) => entry.firstSeenAt > cutoff)
    return [...this.pending]
  }
}
