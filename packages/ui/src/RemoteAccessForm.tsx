import type { RemoteAccessStatus } from '@orch/shared'
import { useState } from 'react'
import { Check, Copy, Link } from './icons'
import { Modal } from './Modal'

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
  /** The server address field. */
  serverUrl: string
  /** The client address field. Empty means links use the one derived from the server address. */
  clientUrl: string
  onServerUrlChange: (value: string) => void
  onClientUrlChange: (value: string) => void
  /** Saves the fields, leaving remote access on or off as it is. */
  onSave: () => void
  /** Saves the fields and turns remote access on or off. */
  onToggle: (enabled: boolean) => void
  /** Replaces the access key and shows the new connect link. */
  onNewLink: () => void
  /** The connect link from the last `onNewLink`. Null means none is shown. */
  link: string | null
  error: string | null
  /** True while a save or a new link is on its way, so the buttons wait. */
  busy: boolean
  onClose: () => void
}

/**
 * The remote access setting: the server and client addresses, an on/off
 * switch, where the tunnel stands, and a button for a fresh connect link. An
 * address set by the host's environment is shown read-only.
 */
export function RemoteAccessForm(props: Props) {
  const { status, link, error, busy } = props
  const [copied, setCopied] = useState(false)
  const enabled = status?.enabled ?? false
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
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault()
          if (!busy) props.onSave()
        }}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2 text-[13px]">
            <span className={`h-2 w-2 shrink-0 rounded-full ${TONE_CLASS[props.statusTone]}`} />
            <span>{props.statusLabel}</span>
            {status?.machineId && (
              <span className="truncate font-mono text-[11px] text-faint" title={status.machineId}>
                {status.machineId}
              </span>
            )}
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label="Remote access"
            disabled={busy || !status}
            onClick={() => props.onToggle(!enabled)}
            className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-60 ${
              enabled ? 'bg-accent' : 'bg-line'
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
                enabled ? 'translate-x-4' : ''
              }`}
            />
          </button>
        </div>

        <label className="block">
          <span className="mb-1 block text-xs text-dim">Server address</span>
          <input
            autoFocus={!status?.serverUrlFromEnv}
            value={props.serverUrl}
            onChange={(event) => props.onServerUrlChange(event.target.value)}
            readOnly={status?.serverUrlFromEnv}
            className={field}
            placeholder="wss://relay.example.com"
            spellCheck={false}
          />
          {status?.serverUrlFromEnv && <span className="mt-1 block text-xs text-faint">Set by SERVER_URL.</span>}
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-dim">Client address (optional)</span>
          <input
            value={props.clientUrl}
            onChange={(event) => props.onClientUrlChange(event.target.value)}
            readOnly={status?.clientUrlFromEnv}
            className={field}
            placeholder="Defaults to the server address over http(s)"
            spellCheck={false}
          />
          {status?.clientUrlFromEnv && <span className="mt-1 block text-xs text-faint">Set by CLIENT_URL.</span>}
        </label>

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
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded-md px-3 py-1.5 text-xs text-dim hover:bg-raised"
              onClick={props.onClose}
            >
              Close
            </button>
            <button
              type="submit"
              disabled={busy || !status}
              className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-on-accent disabled:opacity-60"
            >
              Save
            </button>
          </div>
        </div>
      </form>
    </Modal>
  )
}
