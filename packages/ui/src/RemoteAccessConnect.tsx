import {
  type ConnectOutcome,
  type ConnectRequestStatus,
  connectApprovalText,
  enrollmentFingerprint,
  formatTimeLeft,
  type LinkedAccount,
  sameServerUrl,
} from '@orch/shared'
import { useEffect, useState } from 'react'
import { Button } from './Button'
import { TriangleAlert } from './icons'
import { TextField } from './TextField'

export interface RemoteAccessConnectProps {
  /** The account this machine is connected to. Null shows the Connect fields, or the waiting request, instead. */
  linkedAccount: LinkedAccount | null
  /** The Connect waiting for the owner's answer in the client. Set, it shows in place of the Connect fields. */
  connectRequest: ConnectRequestStatus | null
  /** How the last Connect that waited ended unlinked, shown above the Connect fields. Null shows nothing. */
  connectOutcome: ConnectOutcome | null
  /** This machine's key fingerprint, which the owner checks the client shows before accepting. */
  machineFingerprint: string | null
  /** The "Server address" field. */
  serverUrl: string
  /** The flag or variable that sets the server address, which makes the field read-only. Null means none does. */
  serverUrlSetBy: string | null
  /** The built-in default server address. Connecting to any other shows a warning first. */
  defaultServerUrl: string
  /** The "Email" field: the email of the account to connect to. */
  email: string
  /** The "Key" field: an enrollment key from Connect a machine in the client. */
  enrollmentKey: string
  onServerUrlChange: (value: string) => void
  onEmailChange: (value: string) => void
  onEnrollmentKeyChange: (value: string) => void
  /** Connects with the three fields, once the owner confirmed them. */
  onConnect: () => void
  /** Disconnects, once the owner confirmed it. */
  onDisconnect: () => void
  /** Cancels the Connect that waits for the owner's answer. */
  onCancel: () => void
  /** True while a request is on its way, so the buttons wait. */
  busy: boolean
}

const button = 'rounded-md px-3 py-1.5 text-xs disabled:opacity-60'

/**
 * Connecting this machine to an account, and disconnecting it. Not connected,
 * it shows the server address, email and key fields, then a step that shows
 * what to check before connecting: the email, the server, with a warning for
 * one other than the default, and only the key's last 4 characters. While the
 * request waits for the owner, it asks them to approve it in the client after
 * checking the machine fingerprint, with the time left and Cancel. Connected,
 * it shows the account and its server, read-only, with Disconnect, which asks
 * first. It holds no field values of its own, only which step is showing.
 */
export function RemoteAccessConnect(props: RemoteAccessConnectProps) {
  const { linkedAccount, connectRequest, busy } = props
  const [confirming, setConfirming] = useState(false)

  if (!linkedAccount && connectRequest) {
    return (
      <WaitingForApproval
        expiresAt={connectRequest.expiresAt}
        machineFingerprint={props.machineFingerprint}
        busy={busy}
        onCancel={props.onCancel}
      />
    )
  }

  if (linkedAccount) {
    return (
      <section aria-label="Connected account" className="space-y-1.5 rounded-md border border-line p-2.5 text-[13px]">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate">
              {linkedAccount.name} <span className="text-dim">({linkedAccount.maskedEmail})</span>
            </div>
            <div className="truncate font-mono text-[11px] text-faint">{linkedAccount.serverUrl}</div>
          </div>
          {!confirming && (
            <button
              type="button"
              disabled={busy}
              className={`${button} shrink-0 text-dim hover:bg-raised hover:text-ink`}
              onClick={() => setConfirming(true)}
            >
              Disconnect
            </button>
          )}
        </div>
        {confirming && (
          <div role="group" aria-label="Confirm disconnect" className="space-y-2">
            <p className="text-xs text-dim">
              Disconnect from this account? This machine forgets it and its approved browsers, and asks the server to
              remove it from the account's list.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className={`${button} text-dim hover:bg-raised`}
                onClick={() => setConfirming(false)}
              >
                Cancel
              </button>
              <Button
                disabled={busy}
                onClick={() => {
                  setConfirming(false)
                  props.onDisconnect()
                }}
              >
                Disconnect
              </Button>
            </div>
          </div>
        )}
      </section>
    )
  }

  const serverUrl = props.serverUrl.trim()
  const email = props.email.trim()
  const key = props.enrollmentKey.trim()
  const filled = serverUrl !== '' && email !== '' && key !== ''

  if (confirming) {
    return (
      <section
        aria-label="Check before connecting"
        className="space-y-2 rounded-md border border-line p-2.5 text-[13px]"
      >
        <p className="text-xs text-dim">Check these match the account and the key you created, then connect.</p>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
          <dt className="text-dim">Email</dt>
          <dd className="truncate">{email}</dd>
          <dt className="text-dim">Server</dt>
          <dd className="truncate font-mono text-xs">{serverUrl}</dd>
          <dt className="text-dim">Key ends in</dt>
          <dd className="font-mono text-xs">{enrollmentFingerprint(key)}</dd>
        </dl>
        {!sameServerUrl(serverUrl, props.defaultServerUrl) && (
          <p role="alert" className="flex items-start gap-1.5 text-xs text-warn">
            <TriangleAlert size={13} className="mt-px shrink-0" />
            This is not the default server. Connect only if you run it or trust it.
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className={`${button} text-dim hover:bg-raised`} onClick={() => setConfirming(false)}>
            Back
          </button>
          <Button
            disabled={busy}
            onClick={() => {
              setConfirming(false)
              props.onConnect()
            }}
          >
            Connect
          </Button>
        </div>
      </section>
    )
  }

  const setBy = props.serverUrlSetBy
  return (
    <form
      aria-label="Connect to an account"
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (filled && !busy) setConfirming(true)
      }}
    >
      {props.connectOutcome && (
        <p role="status" className="flex items-start gap-1.5 text-xs text-warn">
          <TriangleAlert size={13} className="mt-px shrink-0" />
          {props.connectOutcome.message}
        </p>
      )}
      <TextField
        label="Server address"
        name="server-url"
        autoComplete="off"
        value={props.serverUrl}
        onChange={props.onServerUrlChange}
        readOnly={setBy !== null}
        hint={setBy !== null ? `Set by ${setBy}.` : undefined}
      />
      <TextField
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        value={props.email}
        onChange={props.onEmailChange}
      />
      <TextField
        label="Key"
        name="enrollment-key"
        autoComplete="off"
        value={props.enrollmentKey}
        onChange={props.onEnrollmentKeyChange}
        hint="From Connect a machine in the client. It works once, for 15 minutes."
      />
      <div className="flex justify-end">
        <Button type="submit" disabled={!filled || busy}>
          Connect
        </Button>
      </div>
    </form>
  )
}

/**
 * The request that waits for the owner: what to check in the client, the
 * time left until `expiresAt`, counting down each second, and Cancel.
 */
function WaitingForApproval({
  expiresAt,
  machineFingerprint,
  busy,
  onCancel,
}: {
  expiresAt: string
  machineFingerprint: string | null
  busy: boolean
  onCancel: () => void
}) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return (
    <section aria-label="Waiting for approval" className="space-y-2 rounded-md border border-line p-2.5 text-[13px]">
      <p>{connectApprovalText(machineFingerprint ?? 'unknown')}</p>
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-dim">
          Time left <span className="font-mono text-ink">{formatTimeLeft(Date.parse(expiresAt) - now)}</span>
        </span>
        <button
          type="button"
          disabled={busy}
          className={`${button} shrink-0 text-dim hover:bg-raised hover:text-ink`}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </section>
  )
}
