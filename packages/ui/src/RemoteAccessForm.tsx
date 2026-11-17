import type { RemoteAccessStatus } from '@orch/shared'
import { useState } from 'react'
import { Check, Copy, Link } from './icons'
import { Modal } from './Modal'
import { RemoteAccessActivity, type RemoteAccessActivityProps } from './RemoteAccessActivity'
import { RemoteAccessConnect, type RemoteAccessConnectProps } from './RemoteAccessConnect'
import { RemoteAccessDevices, type RemoteAccessDevicesProps } from './RemoteAccessDevices'
import { RemoteAccessSessions, type RemoteAccessSessionsProps } from './RemoteAccessSessions'

/** How the status dot is coloured. */
export type RemoteAccessTone = 'good' | 'warn' | 'bad' | 'off'

const TONE_CLASS: Record<RemoteAccessTone, string> = {
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
   * Connecting to an account and disconnecting from it. The account, the
   * address's setter, the default address and `busy` come from this form's props.
   */
  connection: Omit<RemoteAccessConnectProps, 'linkedAccount' | 'serverUrlSetBy' | 'defaultServerUrl' | 'busy'>
  /** The browsers approved for the connected account, and those waiting. Shown only while connected. */
  devices: Omit<RemoteAccessDevicesProps, 'busy'>
  /** The newest remote access recorded on this machine. Shown once the status has loaded. */
  activity: RemoteAccessActivityProps
  /** The browsers with tunneled sockets open. Shown while connected or any session is listed. */
  sessions?: Omit<RemoteAccessSessionsProps, 'busy'>
  error: string | null
  /** What the owner still has to do after an action that worked, such as removing the machine in the client. */
  notice: string | null
  /** True while a connect, a disconnect, a new link or a device change is on its way, so the buttons wait. */
  busy: boolean
  onClose: () => void
}

/**
 * The Remote access dialog: where the connection stands, with the machine's id
 * and key fingerprint, the Connect fields or the connected account with
 * Disconnect, the browsers approved for the account, the open sessions, the
 * recent remote access and a button for a fresh connect link. A server
 * address set by a flag or the host's environment is shown read-only.
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
          <span className={`h-2 w-2 shrink-0 rounded-full ${TONE_CLASS[props.statusTone]}`} />
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
            serverUrlSetBy={status.serverUrlSetBy}
            defaultServerUrl={status.defaultServerUrl}
            busy={busy}
          />
        )}
        {status?.linkedAccount && <RemoteAccessDevices {...props.devices} busy={busy} />}
        {props.sessions && (status?.linkedAccount || (props.sessions.sessions?.sessions.length ?? 0) > 0) && (
          <RemoteAccessSessions {...props.sessions} busy={busy} />
        )}
        {status && <RemoteAccessActivity {...props.activity} />}

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
