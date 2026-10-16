// The layout model shared by the host and every client. The host stores it,
// clients render it, and all changes go through `reduce`.

export type SurfaceKind = 'terminal' | 'pulls' | 'issues'

/** One tab inside a pane. A terminal surface's id is also its session id. */
export interface Surface {
  id: string
  kind: SurfaceKind
  title: string
}

export interface PaneNode {
  type: 'pane'
  id: string
  surfaces: Surface[]
  activeSurfaceId: string
}

export interface SplitNode {
  type: 'split'
  id: string
  /** `row` puts the children side by side, `column` stacks them. */
  direction: 'row' | 'column'
  /** Share of the space given to `a`, between 0 and 1. */
  ratio: number
  a: LayoutNode
  b: LayoutNode
}

export type LayoutNode = PaneNode | SplitNode

export interface Workspace {
  id: string
  name: string
  cwd: string
  root: LayoutNode
}

export interface AppState {
  rev: number
  workspaces: Workspace[]
}

export type Action =
  | { type: 'workspace.add'; workspace: Workspace }
  | { type: 'workspace.remove'; workspaceId: string }
  | { type: 'workspace.rename'; workspaceId: string; name: string }
  | {
      type: 'pane.split'
      workspaceId: string
      paneId: string
      direction: 'row' | 'column'
      splitId: string
      newPane: PaneNode
    }
  | { type: 'surface.add'; workspaceId: string; paneId: string; surface: Surface }
  | { type: 'surface.close'; workspaceId: string; surfaceId: string; fallback: PaneNode }
  | { type: 'surface.select'; workspaceId: string; paneId: string; surfaceId: string }
  | { type: 'surface.move'; workspaceId: string; surfaceId: string; toPaneId: string; fallback: PaneNode }
  | { type: 'split.resize'; workspaceId: string; splitId: string; ratio: number }

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
}

const SURFACE_TITLES: Record<SurfaceKind, string> = {
  terminal: 'Terminal',
  pulls: 'Pull requests',
  issues: 'Issues',
}

export function makeSurface(kind: SurfaceKind = 'terminal'): Surface {
  return { id: newId(kind === 'terminal' ? 'term' : 'surf'), kind, title: SURFACE_TITLES[kind] }
}

export function makePane(surfaces: Surface[] = [makeSurface()]): PaneNode {
  return { type: 'pane', id: newId('pane'), surfaces, activeSurfaceId: surfaces[0].id }
}

export function makeWorkspace(name: string, cwd: string, root: LayoutNode = makePane()): Workspace {
  return { id: newId('ws'), name, cwd, root }
}

export function listPanes(node: LayoutNode): PaneNode[] {
  return node.type === 'pane' ? [node] : [...listPanes(node.a), ...listPanes(node.b)]
}

export function findPane(node: LayoutNode, paneId: string): PaneNode | undefined {
  return listPanes(node).find((p) => p.id === paneId)
}

export function findPaneOfSurface(node: LayoutNode, surfaceId: string): PaneNode | undefined {
  return listPanes(node).find((p) => p.surfaces.some((s) => s.id === surfaceId))
}

export function listSurfaces(state: AppState): Surface[] {
  return state.workspaces.flatMap((w) => listPanes(w.root).flatMap((p) => p.surfaces))
}

/** Where a surface lives, for jumping to it from a notification. */
export function locateSurface(
  state: AppState,
  surfaceId: string,
): { workspace: Workspace; pane: PaneNode } | undefined {
  for (const workspace of state.workspaces) {
    const pane = findPaneOfSurface(workspace.root, surfaceId)
    if (pane) return { workspace, pane }
  }
  return undefined
}

function mapPane(node: LayoutNode, paneId: string, fn: (pane: PaneNode) => LayoutNode): LayoutNode {
  if (node.type === 'pane') return node.id === paneId ? fn(node) : node
  const a = mapPane(node.a, paneId, fn)
  const b = mapPane(node.b, paneId, fn)
  return a === node.a && b === node.b ? node : { ...node, a, b }
}

function mapSplit(node: LayoutNode, splitId: string, fn: (split: SplitNode) => SplitNode): LayoutNode {
  if (node.type === 'pane') return node
  if (node.id === splitId) return fn(node)
  const a = mapSplit(node.a, splitId, fn)
  const b = mapSplit(node.b, splitId, fn)
  return a === node.a && b === node.b ? node : { ...node, a, b }
}

/** Removes a surface; a pane left empty collapses into its sibling. */
function removeSurface(node: LayoutNode, surfaceId: string): LayoutNode | null {
  if (node.type === 'pane') {
    const index = node.surfaces.findIndex((s) => s.id === surfaceId)
    if (index === -1) return node
    const surfaces = node.surfaces.filter((s) => s.id !== surfaceId)
    if (surfaces.length === 0) return null
    const activeSurfaceId =
      node.activeSurfaceId === surfaceId ? surfaces[Math.min(index, surfaces.length - 1)].id : node.activeSurfaceId
    return { ...node, surfaces, activeSurfaceId }
  }
  const a = removeSurface(node.a, surfaceId)
  const b = removeSurface(node.b, surfaceId)
  if (a === null) return b
  if (b === null) return a
  return a === node.a && b === node.b ? node : { ...node, a, b }
}

function updateWorkspace(state: AppState, workspaceId: string, fn: (workspace: Workspace) => Workspace): AppState {
  let changed = false
  const workspaces = state.workspaces.map((w) => {
    if (w.id !== workspaceId) return w
    const next = fn(w)
    if (next !== w) changed = true
    return next
  })
  return changed ? { ...state, workspaces } : state
}

function withRoot(workspace: Workspace, root: LayoutNode): Workspace {
  return root === workspace.root ? workspace : { ...workspace, root }
}

export function reduce(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'workspace.add':
      return { ...state, workspaces: [...state.workspaces, action.workspace] }
    case 'workspace.remove':
      return { ...state, workspaces: state.workspaces.filter((w) => w.id !== action.workspaceId) }
    case 'workspace.rename':
      return updateWorkspace(state, action.workspaceId, (w) => ({ ...w, name: action.name }))
    case 'pane.split':
      return updateWorkspace(state, action.workspaceId, (w) =>
        withRoot(
          w,
          mapPane(w.root, action.paneId, (pane) => ({
            type: 'split',
            id: action.splitId,
            direction: action.direction,
            ratio: 0.5,
            a: pane,
            b: action.newPane,
          })),
        ),
      )
    case 'surface.add':
      return updateWorkspace(state, action.workspaceId, (w) =>
        withRoot(
          w,
          mapPane(w.root, action.paneId, (pane) => ({
            ...pane,
            surfaces: [...pane.surfaces, action.surface],
            activeSurfaceId: action.surface.id,
          })),
        ),
      )
    case 'surface.close':
      return updateWorkspace(state, action.workspaceId, (w) =>
        withRoot(w, removeSurface(w.root, action.surfaceId) ?? action.fallback),
      )
    case 'surface.select':
      return updateWorkspace(state, action.workspaceId, (w) =>
        withRoot(
          w,
          mapPane(w.root, action.paneId, (pane) =>
            pane.activeSurfaceId === action.surfaceId ? pane : { ...pane, activeSurfaceId: action.surfaceId },
          ),
        ),
      )
    case 'surface.move':
      return updateWorkspace(state, action.workspaceId, (w) => {
        const from = findPaneOfSurface(w.root, action.surfaceId)
        const surface = from?.surfaces.find((s) => s.id === action.surfaceId)
        if (!from || !surface || from.id === action.toPaneId || !findPane(w.root, action.toPaneId)) return w
        const without = removeSurface(w.root, action.surfaceId) ?? action.fallback
        return withRoot(
          w,
          mapPane(without, action.toPaneId, (pane) => ({
            ...pane,
            surfaces: [...pane.surfaces, surface],
            activeSurfaceId: surface.id,
          })),
        )
      })
    case 'split.resize':
      return updateWorkspace(state, action.workspaceId, (w) =>
        withRoot(
          w,
          mapSplit(w.root, action.splitId, (split) => ({
            ...split,
            ratio: Math.min(0.9, Math.max(0.1, action.ratio)),
          })),
        ),
      )
  }
}
