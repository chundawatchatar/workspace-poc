import { type AuditLogEntry, type AuditRefusalReason, formatLocalDateTime } from '@orch/shared'

export interface RemoteAccessActivityProps {
  /** The newest entries of the host's audit log, newest first, or undefined while they load. */
  entries: AuditLogEntry[] | undefined
}

/** What each refusal reason says to the owner. */
const REASON_LABEL: Record<AuditRefusalReason, string> = {
  key_refused: 'Refused: wrong access key',
  ticket_refused: 'Refused: account ticket not valid',
  ticket_reused: 'Refused: account ticket used again',
  proof_refused: 'Refused: browser proof not valid',
  device_not_approved: 'Refused: browser not approved',
  no_auth: 'Refused: no sign-in sent',
}

/**
 * Recent remote access to this machine: each tunneled session, with the
 * browser's fingerprint, who it opened as and when it opened and closed, and
 * each refused request or socket with its reason.
 */
export function RemoteAccessActivity({ entries }: RemoteAccessActivityProps) {
  return (
    <section aria-label="Recent activity" className="space-y-2 rounded-md border border-line p-2.5 text-[13px]">
      <div className="text-xs text-dim">Recent activity</div>
      {entries === undefined ? (
        <p className="text-xs text-faint">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="text-xs text-faint">No remote access recorded yet.</p>
      ) : (
        <ul className="max-h-48 space-y-1.5 overflow-y-auto">
          {entries.map((entry, index) => (
            // Refusals have no id of their own; the list is only ever replaced as a whole.
            <li key={entry.kind === 'session' ? entry.session : `refused-${index}`}>
              <ActivityRow entry={entry} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function ActivityRow({ entry }: { entry: AuditLogEntry }) {
  if (entry.kind === 'refused') {
    return (
      <div className="min-w-0">
        <div className="text-xs text-warn">{REASON_LABEL[entry.reason]}</div>
        <div className="text-[11px] text-faint">
          {formatLocalDateTime(entry.at)}
          {entry.fingerprint && <span className="ml-1.5 font-mono">{entry.fingerprint}</span>}
        </div>
      </div>
    )
  }
  const who = entry.principal === 'account' ? 'Through the account' : `With access key ${entry.keyId}`
  const closed = entry.closedAt ? `closed ${formatLocalDateTime(entry.closedAt)}` : 'still open or not recorded'
  return (
    <div className="min-w-0">
      <div className="text-xs">
        <span className="font-mono">{entry.fingerprint}</span>
        <span className="ml-1.5 text-dim">{who}</span>
      </div>
      <div className="text-[11px] text-faint">
        Opened {formatLocalDateTime(entry.openedAt)}, {closed}
      </div>
    </div>
  )
}
