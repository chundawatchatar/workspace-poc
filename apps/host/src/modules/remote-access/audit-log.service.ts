import type { AuditLine, AuditLogEntry, AuditSessionEntry } from '@orch/shared'
import type { Principal } from '../../lib/principal'
import type { Refusal } from '../tunnel/tunnel-http.service'
import type { AuditLogRepository } from './audit-log.repository'
import { fingerprintOf } from './device-proof.service'

/** The most entries `recent` answers. */
export const AUDIT_LOG_ENTRIES = 50

/**
 * What the tunnel tells the audit log: a socket that started as `principal`,
 * the end of that socket, or a refused request or socket.
 */
export type AuditEvent =
  | { kind: 'opened'; session: string; principal: Principal }
  | { kind: 'closed'; session: string }
  | ({ kind: 'refused' } & Refusal)

/** Records one audit event. It never throws. */
export type RecordAudit = (event: AuditEvent) => void

/**
 * The remote access audit log: who opened a tunneled socket, as which device
 * and account or key, when it opened and closed, and every refusal with its
 * reason. Only ids, fingerprints, reasons and times are written, never a key,
 * ticket, proof, public key, path, header or anything typed.
 */
export class AuditLogService {
  /** True once a failed write has been reported, so a broken file logs once. */
  private reported = false

  constructor(
    private readonly repository: AuditLogRepository,
    private readonly now: () => number = Date.now,
  ) {}

  /** Writes one event. A write that fails is reported once, without the event, and never reaches the caller. */
  record(event: AuditEvent): void {
    const at = new Date(this.now()).toISOString()
    try {
      this.repository.append(lineOf(event, at))
    } catch (error) {
      if (this.reported) return
      this.reported = true
      const code = (error as { code?: unknown } | null)?.code
      console.error(
        `the remote access audit log ${this.repository.file} could not be written${typeof code === 'string' ? ` (${code})` : ''}`,
      )
    }
  }

  /**
   * The newest entries, newest first, at most `AUDIT_LOG_ENTRIES`. Each
   * `opened` line is merged with its `closed` into one session; a `closed`
   * whose `opened` was cut from the file is dropped.
   */
  recent(): AuditLogEntry[] {
    const entries: AuditLogEntry[] = []
    const sessions = new Map<string, AuditSessionEntry>()
    for (const line of this.repository.read()) {
      if (line.kind === 'opened') {
        const { kind: _, at, ...rest } = line
        const session: AuditSessionEntry = { ...rest, kind: 'session', openedAt: at, closedAt: null }
        sessions.set(line.session, session)
        entries.push(session)
      } else if (line.kind === 'closed') {
        const session = sessions.get(line.session)
        if (session && session.closedAt === null) session.closedAt = line.at
      } else {
        entries.push(line)
      }
    }
    return entries.reverse().slice(0, AUDIT_LOG_ENTRIES)
  }
}

/** The line an event is written as. The principal keeps only its kind, its account or key id, and its device's fingerprint. */
function lineOf(event: AuditEvent, at: string): AuditLine {
  if (event.kind === 'closed') return { kind: 'closed', session: event.session, at }
  if (event.kind === 'refused') {
    const { reason, device } = event
    return device
      ? { kind: 'refused', reason, at, fingerprint: fingerprintOf(device.id), principal: device.principal }
      : { kind: 'refused', reason, at }
  }
  const { session, principal } = event
  const fingerprint = fingerprintOf(principal.deviceId)
  return principal.kind === 'account'
    ? { kind: 'opened', session, principal: 'account', accountId: principal.accountId, fingerprint, at }
    : { kind: 'opened', session, principal: 'key', keyId: principal.keyId, fingerprint, at }
}
