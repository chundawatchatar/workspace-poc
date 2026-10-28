import type { ReactNode } from 'react'
import { connectionCopy } from '../lib/connection'
import { reconnect, useApp } from '../lib/store'
import { usePageOptions } from '../pageOptions'

/** The default `offlineHint`, for a host running from this repo. */
export const LOCAL_OFFLINE_HINT = (
  <>
    Start it with <code className="rounded bg-raised px-1.5 py-0.5 font-mono text-ink">bun run dev</code> in the project
    root.
  </>
)

/** The default `deniedHint`, for a user who doesn't own the machine. */
export const DEFAULT_DENIED_HINT = "Ask the machine's owner for a new connect link."

/** The hint an app passed for the current status, or null when the status has none. */
export function useConnectionHint(): ReactNode {
  const status = useApp((s) => s.status)
  const { offlineHint, deniedHint } = usePageOptions()
  const { hint } = connectionCopy(status)
  return hint === 'offline' ? offlineHint : hint === 'denied' ? deniedHint : null
}

/** Opens the events socket again, for a key that was rejected. */
export function TryAgainButton() {
  return (
    <button
      type="button"
      className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-on-accent"
      onClick={() => reconnect()}
    >
      Try again
    </button>
  )
}

/** Shown until the host has sent the layout. */
export function HostStatus() {
  const status = useApp((s) => s.status)
  const hint = useConnectionHint()
  const { message, retry } = connectionCopy(status)
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-dim">
      <p>{message}</p>
      {hint && <p className="text-xs text-faint">{hint}</p>}
      {retry && <TryAgainButton />}
    </div>
  )
}
