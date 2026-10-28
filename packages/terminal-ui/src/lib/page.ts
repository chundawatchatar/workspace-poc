import type { HostTransport } from '../transport'
import type { Snapshot } from './store'

/**
 * What a page shows: the connecting status, a redirect, the empty home page, or the workspace. Only `connecting`
 * until the store is connected through `transport` and has its layout, so a layout left over from another transport
 * never causes a redirect.
 */
export type PageView = 'connecting' | 'redirect' | 'empty' | 'workspace'

/** True when the store is connected through `transport` and has received its layout. */
export function isReady(snapshot: Snapshot, transport: HostTransport): boolean {
  return snapshot.transport === transport && snapshot.state !== null
}

/**
 * What the page for `workspaceId` shows; `undefined` is the home page. Home redirects to the first workspace, and an
 * unknown workspace redirects home.
 */
export function pageView(snapshot: Snapshot, transport: HostTransport, workspaceId: string | undefined): PageView {
  if (!isReady(snapshot, transport)) return 'connecting'
  const workspaces = snapshot.state?.workspaces ?? []
  if (workspaceId === undefined) return workspaces.length > 0 ? 'redirect' : 'empty'
  return workspaces.some((w) => w.id === workspaceId) ? 'workspace' : 'redirect'
}
