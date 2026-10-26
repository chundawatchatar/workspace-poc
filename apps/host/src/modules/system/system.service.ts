import type { DaemonReport } from '@orch/shared'

/**
 * The terminal daemon's uptime and live terminal count. The start time comes from the last daemon status the host
 * heard, so with no live terminal it may belong to a daemon that has since exited; the uptime is then null.
 */
export function daemonStatus({
  startedAt,
  liveTerminals,
  now,
}: {
  startedAt: number | null
  liveTerminals: number
  now: number
}): DaemonReport {
  const known = startedAt !== null && liveTerminals > 0
  return { uptimeMs: known ? Math.max(0, now - startedAt) : null, liveTerminals }
}
