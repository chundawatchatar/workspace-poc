import { type DevicesResponse, formatLocalDateTime } from '@orch/shared'
import { TextField } from './TextField'

export interface RemoteAccessDevicesProps {
  /** The host's answer, or undefined while it loads. */
  devices: DevicesResponse | undefined
  /** The "Approve a browser" field: the fingerprint the owner types from their own browser. */
  fingerprint: string
  onFingerprintChange: (value: string) => void
  /** Asks the host to approve the waiting browser with this typed fingerprint. */
  onApprove: (fingerprint: string) => void
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
 * waiting for approval, with Dismiss, then the "Approve a browser" field, and
 * the approved ones, with Revoke. Each is shown by the fingerprint its own
 * browser shows. A waiting browser has no Approve button of its own: the owner
 * types the fingerprint their browser shows, so a browser pushed into the list
 * can't be approved by a click.
 */
export function RemoteAccessDevices(props: RemoteAccessDevicesProps) {
  const { devices, fingerprint, onDismiss, onRevoke, busy } = props
  const pending = devices?.pending ?? []
  const approved = devices?.approved ?? []
  const canApprove = !busy && fingerprint.trim() !== ''
  const approve = () => {
    if (canApprove) props.onApprove(fingerprint)
  }
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
                <button
                  type="button"
                  disabled={busy}
                  aria-label={`Dismiss ${device.fingerprint}`}
                  className={`${button} text-dim hover:bg-raised hover:text-ink`}
                  onClick={() => onDismiss(device.id)}
                >
                  Dismiss
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div
        role="group"
        aria-label="Approve a browser"
        onKeyDown={(event) => {
          // The field sits inside the settings form, so Enter approves instead of saving.
          if (event.key !== 'Enter') return
          event.preventDefault()
          approve()
        }}
      >
        <TextField
          label="Fingerprint shown in your browser"
          name="device-fingerprint"
          autoComplete="off"
          value={fingerprint}
          onChange={props.onFingerprintChange}
          hint="Type it from your own browser. Never copy one from the waiting list."
          trailing={
            <button
              type="button"
              disabled={!canApprove}
              className={`${button} mr-1 bg-accent font-medium text-on-accent`}
              onClick={approve}
            >
              Approve
            </button>
          }
        />
      </div>
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
