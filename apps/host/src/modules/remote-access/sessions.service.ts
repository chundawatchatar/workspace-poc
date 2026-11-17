import type { SessionsResponse } from '@orch/shared'
import type { OpenChannel } from '../tunnel/tunnel-channels.service'
import { fingerprintOf } from './device-proof.service'

/**
 * Groups open channels by device: the account as its one credential, the
 * socket count, and the earliest `openedAt` as `startedAt`. Newest
 * `startedAt` first. Account ids are left out.
 */
export function groupSessions(channels: OpenChannel[]): SessionsResponse['sessions'] {
  const byDevice = new Map<string, { sockets: number; startedAt: number }>()
  for (const { principal, openedAt } of channels) {
    const entry = byDevice.get(principal.deviceId) ?? { sockets: 0, startedAt: openedAt }
    entry.sockets++
    entry.startedAt = Math.min(entry.startedAt, openedAt)
    byDevice.set(principal.deviceId, entry)
  }
  return [...byDevice]
    .sort(([, a], [, b]) => b.startedAt - a.startedAt)
    .map(([deviceId, entry]) => ({
      deviceId,
      fingerprint: fingerprintOf(deviceId),
      credentials: [{ kind: 'account' }],
      sockets: entry.sockets,
      startedAt: new Date(entry.startedAt).toISOString(),
    }))
}
