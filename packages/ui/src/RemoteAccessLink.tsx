import type { LinkedAccount, PreviewLinkResponse } from '@orch/shared'
import { TriangleAlert } from './icons'

export interface RemoteAccessLinkProps {
  /** The account this machine is linked to. Null shows the "Link key" field instead. */
  linkedAccount: LinkedAccount | null
  /** The "Link key" field. */
  linkKey: string
  onLinkKeyChange: (value: string) => void
  /** Asks the host which account the key belongs to, without using it. */
  onPreview: () => void
  /** What the user checks before linking. Null means no key is being checked. */
  preview: PreviewLinkResponse | null
  /** Uses the key the preview shows. */
  onLink: () => void
  /** Drops the preview and the key. */
  onCancel: () => void
  onUnlink: () => void
  /** True while a request is on its way, so the buttons wait. */
  busy: boolean
}

const button = 'rounded-md px-3 py-1.5 text-xs disabled:opacity-60'

/**
 * Linking this machine to an account with a key: the "Link key" field, then
 * the server address, account and fingerprint to check before the key is
 * used, and once linked, the account with an Unlink button.
 */
export function RemoteAccessLink(props: RemoteAccessLinkProps) {
  const { linkedAccount, preview, busy } = props

  if (linkedAccount) {
    return (
      <section aria-label="Linked account" className="space-y-1.5 rounded-md border border-line p-2.5 text-[13px]">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate">
              Linked to {linkedAccount.name} <span className="text-dim">({linkedAccount.maskedEmail})</span>
            </div>
            <div className="truncate font-mono text-[11px] text-faint">{linkedAccount.serverUrl}</div>
          </div>
          <button
            type="button"
            disabled={busy}
            className={`${button} shrink-0 text-dim hover:bg-raised hover:text-ink`}
            onClick={props.onUnlink}
          >
            Unlink
          </button>
        </div>
        <p className="text-xs text-faint">
          Unlink forgets the account on this machine only. Unlink it in the client to remove it from the account.
        </p>
      </section>
    )
  }

  if (preview) {
    return (
      <section aria-label="Check before linking" className="space-y-2 rounded-md border border-line p-2.5 text-[13px]">
        <p className="text-xs text-dim">Check these match the key you created, then link.</p>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
          <dt className="text-dim">Server</dt>
          <dd className="truncate font-mono text-xs">{preview.serverUrl}</dd>
          <dt className="text-dim">Account</dt>
          <dd className="truncate">{preview.account.name}</dd>
          <dt className="text-dim">Email</dt>
          <dd className="truncate">{preview.account.maskedEmail}</dd>
          <dt className="text-dim">Key ends in</dt>
          <dd className="font-mono text-xs">{preview.fingerprint}</dd>
        </dl>
        {!preview.serverUrlIsDefault && (
          <p role="alert" className="flex items-start gap-1.5 text-xs text-warn">
            <TriangleAlert size={13} className="mt-px shrink-0" />
            This is not the default server. Link only if you run it or trust it.
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className={`${button} text-dim hover:bg-raised`} onClick={props.onCancel}>
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            className={`${button} bg-accent font-medium text-on-accent`}
            onClick={props.onLink}
          >
            Link
          </button>
        </div>
      </section>
    )
  }

  return (
    <div>
      <label htmlFor="remote-access-link-key" className="mb-1 block text-xs text-dim">
        Link key
      </label>
      <div className="flex gap-1.5">
        <input
          id="remote-access-link-key"
          value={props.linkKey}
          onChange={(event) => props.onLinkKeyChange(event.target.value)}
          onKeyDown={(event) => {
            // The field sits inside the settings form, so Enter previews the key instead of saving.
            if (event.key !== 'Enter') return
            event.preventDefault()
            if (!busy && props.linkKey.trim()) props.onPreview()
          }}
          className="w-full rounded-md border border-line bg-bg px-2.5 py-1.5 font-mono text-[13px] outline-none focus:border-accent"
          placeholder="oek_…"
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="button"
          disabled={busy || !props.linkKey.trim()}
          className={`${button} shrink-0 border border-line text-dim hover:bg-raised hover:text-ink`}
          onClick={props.onPreview}
        >
          Preview
        </button>
      </div>
    </div>
  )
}
