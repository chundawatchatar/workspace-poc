import { type DevicesResponse, routes } from '@orch/shared'
import { apiQuery } from './api'

/** How often a local page asks the host for browsers waiting for approval. */
export const PENDING_DEVICES_POLL_MS = 5000

/** A browser waiting for approval, as the Notifications menu shows it: its fingerprint and when it first asked. */
export interface DeviceNotice {
  fingerprint: string
  /** ISO time. */
  firstSeenAt: string
}

/** The waiting browsers in a devices response, newest first, with nothing but what the menu shows. */
export function deviceNotices(response: DevicesResponse): DeviceNotice[] {
  return response.pending.map(({ fingerprint, firstSeenAt }) => ({ fingerprint, firstSeenAt }))
}

/**
 * Polls `routes.remoteAccess.devices` for the waiting browsers, only while
 * `enabled`, which a page sets only when it offers the Remote access setting,
 * since the route answers 403 through the tunnel. A failed poll is not retried
 * and leaves no items, so a host without remote access stays quiet.
 */
export function pendingDevicesQuery(enabled: boolean) {
  return {
    ...apiQuery(routes.remoteAccess.devices, {}),
    enabled,
    refetchInterval: PENDING_DEVICES_POLL_MS,
    retry: false,
    select: deviceNotices,
  }
}

/** When a browser first asked, as a local clock time such as `12:05`. */
export function askedAtLabel(firstSeenAt: string): string {
  return new Date(firstSeenAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
