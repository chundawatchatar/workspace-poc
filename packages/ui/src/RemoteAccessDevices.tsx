import { type DevicesResponse, formatLocalDateTime } from '@orch/shared'

export interface RemoteAccessDevicesProps {
  /** The host's answer, or undefined while it loads. */
  devices: DevicesResponse | undefined
  onApprove: (id: string) => void
  /** Drops a waiting browser without approving it. */
  onDismiss: (id: string) => void
  /** Takes an approved browser's access away and closes what it has open. */
  onRevoke: (id: string) => void
  /** True while a request is on its way, so the buttons wait. */
  busy: boolean
}

const button = 'shrink-0 rounded-md px-2.5 py-1 text-xs disabled:opacity-60'

/**
 * The browsers that may open this machine through the linked account: those
 * waiting for approval, with Approve and Dismiss, and the approved ones, with
 * Revoke. Each is shown by the fingerprint its own browser shows.
 */
export function RemoteAccessDevices({ devices, onApprove, onDismiss, onRevoke, busy }: RemoteAccessDevicesProps) {
  const pending = devices?.pending ?? []
  const approved = devices?.approved ?? []
  return (
    <section aria-label="Devices" className="space-y-2 rounded-md border border-line p-2.5 text-[13px]">
      <div className="text-xs text-dim">Browsers that open this machine through the account</div>
      {pending.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs text-warn">
            Approve only a fingerprint shown in your own browser. A browser you don't recognise could be someone else's:
            dismiss it.
          </p>
          <ul aria-label="Waiting for approval" className="space-y-1">
            {pending.map((device) => (
              <li key={device.id} className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-mono text-xs">{device.fingerprint}</div>
                  <div className="text-[11px] text-faint">First seen {formatLocalDateTime(device.firstSeenAt)}</div>
                </div>
                <div className="flex gap-1">
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Dismiss ${device.fingerprint}`}
                    className={`${button} text-dim hover:bg-raised hover:text-ink`}
                    onClick={() => onDismiss(device.id)}
                  >
                    Dismiss
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Approve ${device.fingerprint}`}
                    className={`${button} bg-accent font-medium text-on-accent`}
                    onClick={() => onApprove(device.id)}
                  >
                    Approve
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      {approved.length > 0 ? (
        <ul aria-label="Approved" className="space-y-1">
          {approved.map((device) => (
            <li key={device.id} className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="font-mono text-xs">{device.fingerprint}</div>
                <div className="text-[11px] text-faint">Approved {formatLocalDateTime(device.approvedAt)}</div>
              </div>
              <button
                type="button"
                disabled={busy}
                aria-label={`Revoke ${device.fingerprint}`}
                className={`${button} text-dim hover:bg-raised hover:text-ink`}
                onClick={() => onRevoke(device.id)}
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-faint">
          No browser is approved yet. Open this machine from the client, then approve the fingerprint it shows.
        </p>
      )}
    </section>
  )
}
