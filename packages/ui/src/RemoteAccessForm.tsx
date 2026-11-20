import type { RemoteAccessStatus } from '@orch/shared'
import { Modal } from './Modal'
import { RemoteAccessConnect, type RemoteAccessConnectProps } from './RemoteAccessConnect'
import { RemoteAccessDevices, type RemoteAccessDevicesProps } from './RemoteAccessDevices'

/** How the status dot is coloured. */
export type RemoteAccessTone = 'good' | 'warn' | 'bad' | 'off'

/** The background class of the status dot for each tone. */
export const REMOTE_ACCESS_TONE_CLASS: Record<RemoteAccessTone, string> = {
  good: 'bg-good',
  warn: 'bg-warn',
  bad: 'bg-bad',
  off: 'bg-faint',
}

interface Props {
  /** The host's answer, or undefined while it loads. */
  status: RemoteAccessStatus | undefined
  /** What the status line says, such as "Connected". */
  statusLabel: string
  statusTone: RemoteAccessTone
  /**
   * Connecting to an account, waiting for the owner's answer and
   * disconnecting. What comes from the status, and `busy`, come from this
   * form's props.
   */
  connection: Omit<
    RemoteAccessConnectProps,
    | 'linkedAccount'
    | 'connectRequest'
    | 'connectOutcome'
    | 'machineFingerprint'
    | 'serverUrlSetBy'
    | 'defaultServerUrl'
    | 'busy'
    | 'onClose'
    | 'children'
  >
  /** The browsers approved for the connected account, and those waiting. Shown only while connected. */
  devices: Omit<RemoteAccessDevicesProps, 'busy'>
  error: string | null
  /** What the owner still has to do after an action that worked, such as removing the machine in the client. */
  notice: string | null
  /** True while a connect, a disconnect or a device change is on its way, so the buttons wait. */
  busy: boolean
  onClose: () => void
}

/**
 * The Remote access dialog: where the connection stands, with the machine's id
 * and key fingerprint, the Connect fields, the request waiting for the owner
 * or the connected account with Disconnect, and the browsers approved for
 * the account. A server address set by a flag or the host's environment is
 * shown read-only. The open sessions and the
 * recent remote access are not part of it: see `RemoteAccessSessions` and
 * `RemoteAccessActivity`.
 */
export function RemoteAccessForm(props: Props) {
  const { status, error, notice, busy } = props

  const messages = (
    <>
      {error && <p className="text-xs text-bad">{error}</p>}
      {notice && <p className="text-xs text-warn">{notice}</p>}
    </>
  )

  return (
    <Modal title="Remote access" width="w-[520px] max-w-[94vw]" onClose={props.onClose}>
      <div className="space-y-3">
        <div className="space-y-1 rounded-md bg-raised/60 px-3 py-2">
          <div className="flex items-center justify-between gap-3 text-[13px]">
            <span className="flex items-center gap-2 whitespace-nowrap">
              <span className={`h-2 w-2 shrink-0 rounded-full ${REMOTE_ACCESS_TONE_CLASS[props.statusTone]}`} />
              <span role="status">{props.statusLabel}</span>
            </span>
            {status?.machineFingerprint && (
              <span
                className="shrink-0 font-mono text-[11px] text-dim"
                title="Machine key fingerprint. The client asks you to type it before it opens this machine through your account."
              >
                Machine key {status.machineFingerprint}
              </span>
            )}
          </div>
          {status?.machineId && (
            <div className="flex min-w-0 items-center gap-1.5 text-[11px]">
              <span className="shrink-0 text-faint">Machine ID</span>
              <span className="truncate font-mono text-faint" title={status.machineId}>
                {status.machineId}
              </span>
            </div>
          )}
        </div>

        {status ? (
          <RemoteAccessConnect
            {...props.connection}
            linkedAccount={status.linkedAccount}
            connectRequest={status.connectRequest}
            connectOutcome={status.connectOutcome}
            machineFingerprint={status.machineFingerprint}
            serverUrlSetBy={status.serverUrlSetBy}
            defaultServerUrl={status.defaultServerUrl}
            busy={busy}
            onClose={props.onClose}
          >
            {status.linkedAccount && <RemoteAccessDevices {...props.devices} busy={busy} />}
            {messages}
          </RemoteAccessConnect>
        ) : (
          <>
            {messages}
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                className="rounded-md px-3 py-1.5 text-xs text-dim hover:bg-raised hover:text-ink"
                onClick={props.onClose}
              >
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
