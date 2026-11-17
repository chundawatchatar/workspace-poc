import type { RemoteAccessStatus } from '@orch/shared'
import { useState } from 'react'
import { Check, Copy, Link } from './icons'
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
  /** Replaces the access key and shows the new connect link. */
  onNewLink: () => void
  /** The connect link from the last `onNewLink`. Null means none is shown. */
  link: string | null
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
  >
  /** The browsers approved for the connected account, and those waiting. Shown only while connected. */
  devices: Omit<RemoteAccessDevicesProps, 'busy'>
  error: string | null
  /** What the owner still has to do after an action that worked, such as removing the machine in the client. */
  notice: string | null
  /** True while a connect, a disconnect, a new link or a device change is on its way, so the buttons wait. */
  busy: boolean
  onClose: () => void
}

/**
 * The Remote access dialog: where the connection stands, with the machine's id
 * and key fingerprint, the Connect fields, the request waiting for the owner
 * or the connected account with Disconnect, the browsers approved for the
 * account and a button for a fresh connect link. A server address set by a
 * flag or the host's environment is shown read-only. The open sessions and the
 * recent remote access are not part of it: see `RemoteAccessSessions` and
 * `RemoteAccessActivity`.
 */
export function RemoteAccessForm(props: Props) {
  const { status, link, error, notice, busy } = props
  const [copied, setCopied] = useState(false)
  const field =
    'w-full rounded-md border border-line bg-bg px-2.5 py-1.5 font-mono text-[13px] outline-none focus:border-accent read-only:text-dim'

  async function copy() {
    if (!link) return
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <Modal title="Remote access" width="w-[520px] max-w-[94vw]" onClose={props.onClose}>
      <div className="space-y-3">
        <div className="flex min-w-0 items-center gap-2 text-[13px]">
          <span className={`h-2 w-2 shrink-0 rounded-full ${REMOTE_ACCESS_TONE_CLASS[props.statusTone]}`} />
          <span role="status">{props.statusLabel}</span>
          {status?.machineId && (
            <span className="truncate font-mono text-[11px] text-faint" title={status.machineId}>
              {status.machineId}
            </span>
          )}
          {status?.machineFingerprint && (
            <span
              className="shrink-0 font-mono text-[11px] text-dim"
              title="Machine key fingerprint. The client asks you to type it before it opens this machine through your account."
            >
              Machine key {status.machineFingerprint}
            </span>
          )}
        </div>

        {status && (
          <RemoteAccessConnect
            {...props.connection}
            linkedAccount={status.linkedAccount}
            connectRequest={status.connectRequest}
            connectOutcome={status.connectOutcome}
            machineFingerprint={status.machineFingerprint}
            serverUrlSetBy={status.serverUrlSetBy}
            defaultServerUrl={status.defaultServerUrl}
            busy={busy}
          />
        )}
        {status?.linkedAccount && <RemoteAccessDevices {...props.devices} busy={busy} />}

        {link && (
          <div>
            <span className="mb-1 block text-xs text-dim">Connect link. It will not be shown again.</span>
            <div className="flex gap-1.5">
              <input readOnly value={link} className={field} onFocus={(event) => event.target.select()} />
              <button
                type="button"
                title="Copy the link"
                aria-label="Copy the link"
                className="shrink-0 rounded-md border border-line px-2 text-dim hover:bg-raised hover:text-ink"
                onClick={copy}
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </div>
          </div>
        )}

        {error && <p className="text-xs text-bad">{error}</p>}
        {notice && <p className="text-xs text-warn">{notice}</p>}

        <div className="flex items-center justify-between gap-2 pt-1">
          <button
            type="button"
            disabled={busy || !status?.serverUrl}
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs text-dim hover:bg-raised hover:text-ink disabled:opacity-60"
            onClick={props.onNewLink}
          >
            <Link size={13} />
            New connect link
          </button>
          <button
            type="button"
            className="rounded-md px-3 py-1.5 text-xs text-dim hover:bg-raised"
            onClick={props.onClose}
          >
            Close
          </button>
        </div>
      </div>
    </Modal>
  )
}
