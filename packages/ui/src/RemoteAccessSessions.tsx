import { formatLocalDateTime, type RemoteSession, type SessionsResponse } from '@orch/shared'

export interface RemoteAccessSessionsProps {
  /** The host's answer, or undefined while it loads. */
  sessions: SessionsResponse | undefined
  /** Closes the sockets of the device with this id, leaving it approved. */
  onEnd: (id: string) => void
  /** True while a request is on its way, so the buttons wait. */
  busy: boolean
}

/** What a session's credentials read as, such as `Account, Key laptop`. */
export function sessionCredentialsLabel(session: RemoteSession): string {
  return session.credentials
    .map((credential) => (credential.kind === 'account' ? 'Account' : `Key ${credential.name}`))
    .join(', ')
}

/**
 * The approved browsers with sockets open through the tunnel right now, each
 * by its fingerprint, with what it came in with, how many sockets it holds and
 * when the first one opened. End closes them without revoking the browser, so
 * a reload opens the machine again; Revoke in Devices removes it for good.
 */
export function RemoteAccessSessions({ sessions, onEnd, busy }: RemoteAccessSessionsProps) {
  const open = sessions?.sessions ?? []
  return (
    <section aria-label="Sessions" className="space-y-2 rounded-md border border-line p-2.5 text-[13px]">
      <div className="text-xs text-dim">Browsers connected through the tunnel now</div>
      {open.length > 0 ? (
        <>
          <ul aria-label="Open sessions" className="space-y-1">
            {open.map((session) => (
              <li key={session.deviceId} className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-mono text-xs">{session.fingerprint}</div>
                  <div className="text-[11px] text-faint">
                    {sessionCredentialsLabel(session)} · {session.sockets}{' '}
                    {session.sockets === 1 ? 'socket' : 'sockets'} · since {formatLocalDateTime(session.startedAt)}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  aria-label={`End ${session.fingerprint}`}
                  className="shrink-0 rounded-md px-2.5 py-1 text-xs text-dim hover:bg-raised hover:text-ink disabled:opacity-60"
                  onClick={() => onEnd(session.deviceId)}
                >
                  End
                </button>
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-faint">
            End disconnects a browser, but it stays approved and reconnects when its page is reloaded. Revoke it under
            Devices to remove it for good.
          </p>
        </>
      ) : (
        <p className="text-xs text-faint">No browser is connected through the tunnel.</p>
      )}
    </section>
  )
}
