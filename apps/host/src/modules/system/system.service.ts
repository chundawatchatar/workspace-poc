import type { DaemonCompatibility, DaemonReport } from '@orch/shared'

/** What the host last heard from the terminal daemon, from `SharedDaemon.report`. */
export interface DaemonState {
  /** When the daemon started, in epoch milliseconds, or null when no status has said. */
  startedAt: number | null
  compatibility: DaemonCompatibility
  daemonProtocol: number | null
  stopCommand: string
}

/**
 * The terminal daemon's uptime, live terminal count and compatibility. The start time comes from the last daemon
 * status the host heard, so with no live terminal it may belong to a daemon that has since exited; the uptime is
 * then null.
 */
export function daemonStatus({
  startedAt,
  compatibility,
  daemonProtocol,
  stopCommand,
  liveTerminals,
  now,
}: DaemonState & { liveTerminals: number; now: number }): DaemonReport {
  const known = startedAt !== null && liveTerminals > 0
  return {
    uptimeMs: known ? Math.max(0, now - startedAt) : null,
    liveTerminals,
    compatibility,
    daemonProtocol,
    stopCommand,
  }
}
