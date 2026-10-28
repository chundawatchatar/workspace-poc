import { useApp } from '../lib/store'
import { usePageOptions } from '../pageOptions'

/** The default `offlineHint`, for a host running from this repo. */
export const LOCAL_OFFLINE_HINT = (
  <>
    Start it with <code className="rounded bg-raised px-1.5 py-0.5 font-mono text-ink">bun run dev</code> in the project
    root.
  </>
)

/** Shown until the host has sent the layout. */
export function HostStatus() {
  const status = useApp((s) => s.status)
  const { offlineHint } = usePageOptions()
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-dim">
      <p>{status === 'closed' ? 'The host is not running.' : 'Connecting to the host…'}</p>
      {status === 'closed' && <p className="text-xs text-faint">{offlineHint}</p>}
    </div>
  )
}
