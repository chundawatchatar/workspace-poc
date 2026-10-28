import { KeyRound, LoaderCircle, WifiOff } from '@orch/ui/icons'
import { connectionCopy } from '../lib/connection'
import { isReady } from '../lib/page'
import { useApp } from '../lib/store'
import { useTransport } from '../transportContext'
import { TryAgainButton, useConnectionHint } from './HostStatus'

/** A strip above the page while the connection is not open, once the layout has loaded. */
export function ConnectionBanner() {
  const transport = useTransport()
  const ready = useApp((s) => isReady(s, transport))
  const status = useApp((s) => s.status)
  const hint = useConnectionHint()
  const { banner, retry } = connectionCopy(status)
  if (!ready || !banner) return null
  const Icon = status === 'denied' ? KeyRound : status === 'offline' ? WifiOff : LoaderCircle
  return (
    <div
      role="status"
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-raised px-3 py-1.5 text-xs text-dim"
    >
      <Icon
        size={13}
        className={`shrink-0 ${status === 'offline' || status === 'denied' ? 'text-bad' : 'text-warn'}`}
      />
      <span className="text-ink">{banner}</span>
      {hint && <span className="text-faint">{hint}</span>}
      {retry && <TryAgainButton />}
    </div>
  )
}
