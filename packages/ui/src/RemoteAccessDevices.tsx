import {
  type DevicesResponse,
  editFingerprint,
  FINGERPRINT_LENGTH,
  fingerprintKey,
  formatLocalDateTime,
} from '@orch/shared'
import { useRef } from 'react'
import { ShieldAlert } from './icons'
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
 * types the fingerprint their own browser shows, so a browser pushed into the
 * list can't be approved by a click. The field says whether the
 * typed fingerprint matches a waiting browser, and Approve waits until it does.
 * Waiting browsers sit in a highlighted block with a count, so they catch the
 * owner's eye; the approved ones follow in a plain one.
 */
export function RemoteAccessDevices(props: RemoteAccessDevicesProps) {
  const { devices, fingerprint, onDismiss, onRevoke, busy } = props
  const pending = devices?.pending ?? []
  const approved = devices?.approved ?? []
  const typed = fingerprintKey(fingerprint)
  const complete = typed.length === FINGERPRINT_LENGTH
  const match = complete ? pending.find((device) => fingerprintKey(device.fingerprint) === typed) : undefined
  const alreadyApproved = complete && approved.some((device) => fingerprintKey(device.fingerprint) === typed)
  const canApprove = !busy && match !== undefined
  const approve = () => {
    if (canApprove) props.onApprove(fingerprint)
  }
  const field = useRef<HTMLInputElement>(null)
  // Which way the last key deletes, since Backspace after a dash and Delete before it leave the same text.
  const deleting = useRef<'backward' | 'forward'>('backward')
  const changeFingerprint = (typed: string) => {
    const input = field.current
    const edit = editFingerprint(fingerprint, typed, input?.selectionStart ?? typed.length, deleting.current)
    props.onFingerprintChange(edit.value)
    // The formatted value replaces what was typed, which puts the caret at the end, so put it back once it's drawn.
    requestAnimationFrame(() => {
      if (input && document.activeElement === input) input.setSelectionRange(edit.caret, edit.caret)
    })
  }
  const matchNote = !complete
    ? null
    : match
      ? `Matches the browser waiting since ${formatLocalDateTime(match.firstSeenAt)}.`
      : alreadyApproved
        ? 'That browser is already approved.'
        : null
  const matchError =
    complete && !match && !alreadyApproved
      ? 'No waiting browser has this fingerprint. Check it against the one your browser shows.'
      : null
  return (
    <section aria-label="Devices" className="space-y-3 text-[13px]">
      {pending.length > 0 ? (
        <div className="space-y-2.5 rounded-md border border-warn/60 bg-warn/10 p-2.5">
          <div className="flex items-center gap-2 font-medium">
            <span className="relative flex size-2 shrink-0">
              <span className="absolute inline-flex size-full rounded-full bg-warn opacity-75 motion-safe:animate-ping" />
              <span className="relative inline-flex size-2 rounded-full bg-warn" />
            </span>
            <ShieldAlert size={14} className="shrink-0 text-warn" aria-hidden />
            Browser connect requests
            <span className="rounded-full bg-warn/25 px-1.5 text-[11px] leading-4 font-semibold text-ink">
              {pending.length}
            </span>
          </div>
          <ul aria-label="Waiting for approval" className="space-y-1">
            {pending.map((device) => (
              <li
                key={device.id}
                className="flex items-center justify-between gap-2 rounded-md border border-line bg-bg px-2.5 py-1.5"
              >
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
          <div
            role="group"
            aria-label="Approve a browser"
            onKeyDown={(event) => {
              deleting.current = event.key === 'Delete' ? 'forward' : 'backward'
              // Enter in the field approves, as the button does.
              if (event.key !== 'Enter') return
              event.preventDefault()
              approve()
            }}
          >
            <TextField
              label="Fingerprint shown in your browser"
              name="device-fingerprint"
              autoComplete="off"
              placeholder="XXXX-XXXX-XXXX-XXXX"
              mono
              value={fingerprint}
              ref={field}
              onChange={changeFingerprint}
              hint={
                matchNote ??
                "Type the fingerprint your own browser shows, not one from this list. Dismiss any you don't recognise."
              }
              error={matchError}
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
        </div>
      ) : (
        <p className="text-xs text-faint">
          No browser is waiting. Open this machine from the client, and its browser shows up here to approve.
        </p>
      )}
      <div className="space-y-2 rounded-md border border-line p-2.5">
        <div className="text-xs text-dim">Approved browsers</div>
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
          <p className="text-xs text-faint">No browser is approved yet.</p>
        )}
      </div>
    </section>
  )
}
