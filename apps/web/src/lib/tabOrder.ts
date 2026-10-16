import type { AppState, LayoutNode, PaneNode } from '@orch/shared'

// Reordering tabs is done here, on the client, because the shared reducer has
// no action for it yet. It belongs there as an optional index on
// `surface.move`; moving it means restarting the host, which ends its shells.

function mapPane(node: LayoutNode, paneId: string, fn: (pane: PaneNode) => PaneNode): LayoutNode {
  if (node.type === 'pane') return node.id === paneId ? fn(node) : node
  const a = mapPane(node.a, paneId, fn)
  const b = mapPane(node.b, paneId, fn)
  return a === node.a && b === node.b ? node : { ...node, a, b }
}

/**
 * Puts a tab at `index` within its own pane and selects it. `index` counts
 * positions among the pane's tabs as they stand, the moved tab included, so
 * "before the third tab" is 2 wherever the tab started.
 */
export function placeSurface(
  state: AppState,
  workspaceId: string,
  paneId: string,
  surfaceId: string,
  index: number,
): AppState {
  const workspace = state.workspaces.find((w) => w.id === workspaceId)
  if (!workspace) return state
  const root = mapPane(workspace.root, paneId, (pane) => {
    const from = pane.surfaces.findIndex((s) => s.id === surfaceId)
    if (from === -1) return pane
    const to = Math.max(0, Math.min(pane.surfaces.length - 1, index > from ? index - 1 : index))
    if (to === from && pane.activeSurfaceId === surfaceId) return pane
    const surfaces = pane.surfaces.filter((s) => s.id !== surfaceId)
    surfaces.splice(to, 0, pane.surfaces[from])
    return { ...pane, surfaces, activeSurfaceId: surfaceId }
  })
  if (root === workspace.root) return state
  return { ...state, workspaces: state.workspaces.map((w) => (w === workspace ? { ...w, root } : w)) }
}
