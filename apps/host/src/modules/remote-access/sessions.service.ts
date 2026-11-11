import type { SessionCredential, SessionsResponse } from '@orch/shared'
import type { OpenChannel } from '../tunnel/tunnel-channels.service'
import { fingerprintOf } from './device-proof.service'

/**
 * Groups open channels by device: each credential once (the account first,
 * then keys by name), the socket count, and the earliest `openedAt` as
 * `startedAt`. Newest `startedAt` first. Key ids and account ids are left out.
 */
export function groupSessions(channels: OpenChannel[]): SessionsResponse['sessions'] {
  const byDevice = new Map<string, { account: boolean; keys: Set<string>; sockets: number; startedAt: number }>()
  for (const { principal, openedAt } of channels) {
    const entry = byDevice.get(principal.deviceId) ?? {
      account: false,
      keys: new Set(),
      sockets: 0,
      startedAt: openedAt,
    }
    if (principal.kind === 'account') entry.account = true
    else entry.keys.add(principal.name)
    entry.sockets++
    entry.startedAt = Math.min(entry.startedAt, openedAt)
    byDevice.set(principal.deviceId, entry)
  }
  return [...byDevice]
    .sort(([, a], [, b]) => b.startedAt - a.startedAt)
    .map(([deviceId, entry]) => {
      const credentials: SessionCredential[] = entry.account ? [{ kind: 'account' }] : []
      for (const name of [...entry.keys].sort()) credentials.push({ kind: 'key', name })
      return {
        deviceId,
        fingerprint: fingerprintOf(deviceId),
        credentials,
        sockets: entry.sockets,
        startedAt: new Date(entry.startedAt).toISOString(),
      }
    })
}
