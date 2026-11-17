import {
  answerBrowserHandshake,
  type E2eBrowserHello,
  type E2eSession,
  type OpenE2eSessionResponse,
} from '@orch/shared'
import type { Principal } from '../../lib/principal'
import { deviceIdOf } from '../remote-access/device-proof.service'
import type { MachineKey } from '../tunnel/tunnel.repository'

/** Live sessions one device may hold. Several tabs share a device, and a device opening sessions in a loop stays bounded. */
export const MAX_SESSIONS_PER_DEVICE = 8

/** A hello signed by another device than the one whose proof came with the request. */
export class E2eDeviceMismatch extends Error {
  constructor() {
    super('the hello is not signed by the device that sent it')
    this.name = 'E2eDeviceMismatch'
  }
}

/** Access ended (the device was revoked, the account unlinked, remote access turned off) while the session opened. */
export class E2eSessionClosed extends Error {
  constructor() {
    super('access ended while the session opened')
    this.name = 'E2eSessionClosed'
  }
}

/** An open end-to-end session, as later jobs read it with `get`. */
export interface E2eSessionEntry {
  /** Who opened it, so revoking that access closes it. */
  principal: Principal
  session: E2eSession
  /** When it expires, in epoch milliseconds. */
  expiresAt: number
}

export interface E2eSessionsOptions {
  /** The machine key, or null when none exists yet. Read at each open, so a key created later is used. */
  machineKey: () => MachineKey | null
  /** The clock, in epoch milliseconds. Tests pass a fake one. */
  now?: () => number
}

/**
 * The end-to-end sessions browsers opened with this machine (REM-2), in
 * memory only: they are never written to the data folder, so a restart forgets them
 * and browsers open new ones. A session expires with the relay ticket that
 * opened it. Each
 * device holds at most `MAX_SESSIONS_PER_DEVICE`, dropping its oldest.
 */
export class E2eSessions {
  /** Live sessions by id, in the order they opened. */
  private readonly sessions = new Map<string, E2eSessionEntry>()
  /** Opens still waiting for the handshake, so a close that runs meanwhile cancels them too. */
  private readonly opening = new Set<{ principal: Principal; cancelled: boolean }>()
  private readonly now: () => number

  constructor(private readonly options: E2eSessionsOptions) {
    this.now = options.now ?? Date.now
  }

  /**
   * Answers `hello` from `principal`'s device, signed with the machine key, and
   * keeps the session. Throws `E2eDeviceMismatch` when another device signed
   * the hello, `E2eError` when its signature doesn't verify, and
   * `E2eSessionClosed` when the principal's access closed meanwhile.
   */
  async open(principal: Principal, hello: E2eBrowserHello): Promise<OpenE2eSessionResponse> {
    if (deviceIdOf(hello.device) !== principal.deviceId) throw new E2eDeviceMismatch()
    const machineKey = this.options.machineKey()
    if (!machineKey) throw new Error('this machine has no machine key yet')
    const pending = { principal, cancelled: false }
    this.opening.add(pending)
    let answer: Awaited<ReturnType<typeof answerBrowserHandshake>>
    try {
      answer = await answerBrowserHandshake({
        machineId: machineKey.machineId,
        machine: {
          publicKey: machineKey.publicKey,
          sign: async (data) => new Uint8Array(Buffer.from(machineKey.sign(data), 'base64url')),
        },
        hello,
      })
    } finally {
      this.opening.delete(pending)
    }
    if (pending.cancelled) throw new E2eSessionClosed()

    const now = this.now()
    this.prune(now)
    const expiresAt = principal.ticketExp * 1000
    const ofDevice = [...this.sessions].filter(([, entry]) => entry.principal.deviceId === principal.deviceId)
    for (const [id] of ofDevice.slice(0, Math.max(0, ofDevice.length - MAX_SESSIONS_PER_DEVICE + 1))) {
      this.sessions.delete(id)
    }
    const sessionId = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url')
    this.sessions.set(sessionId, { principal, session: answer.session, expiresAt })
    return { sessionId, hello: answer.reply, expiresAt: new Date(expiresAt).toISOString() }
  }

  /** The session with this id, or null when there is none, it expired or it was closed. */
  get(sessionId: string): E2eSessionEntry | null {
    this.prune(this.now())
    return this.sessions.get(sessionId) ?? null
  }

  /** Closes every session, and every open in progress, whose principal `matches`. */
  closeWhere(matches: (principal: Principal) => boolean): void {
    for (const [id, entry] of this.sessions) if (matches(entry.principal)) this.sessions.delete(id)
    for (const pending of this.opening) if (matches(pending.principal)) pending.cancelled = true
  }

  /** Closes every session, and every open in progress. */
  closeAll(): void {
    this.closeWhere(() => true)
  }

  /** Drops the sessions that have expired by `now`. */
  private prune(now: number) {
    for (const [id, entry] of this.sessions) if (entry.expiresAt <= now) this.sessions.delete(id)
  }
}
